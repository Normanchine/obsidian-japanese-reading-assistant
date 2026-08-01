import {
  Component,
  ItemView,
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  type Editor,
  type WorkspaceLeaf,
} from "obsidian";
import {
  classifySelection,
  containsJapanese,
  humanizeError,
  isLikelyJapaneseSelection,
  isTriggerModifierSatisfied,
  normalizeSelection,
} from "./core";
import { FloatingResultPopup } from "./popup";
import {
  analyzeJapanese,
  checkPaddleOcrService,
  listDeepSeekModels,
  listOllamaModels,
  recognizeJapaneseFromImage,
  restartPaddleOcrService,
} from "./providers";
import {
  capturePdfRegion,
  findPdfPageCanvas,
} from "./pdf-ocr";
import { createEditorSelectionExtension } from "./selection-extension";
import { JapaneseReadingSettingTab } from "./settings";
import type {
  AnalysisMode,
  AnalysisResult,
  JapaneseReadingSettings,
  ModifierGesture,
  ModifierSnapshot,
  RectLike,
  SelectionContext,
} from "./types";

const DEFAULT_SETTINGS: JapaneseReadingSettings = {
  schemaVersion: 6,
  provider: "ollama",
  deepseekApiKey: "",
  deepseekBaseUrl: "https://api.deepseek.com",
  deepseekModel: "deepseek-v4-flash",
  ollamaBaseUrl: "http://127.0.0.1:11434",
  ollamaModel: "qwen2.5:7b",
  ocrProvider: "paddle",
  paddleOcrBaseUrl: "http://127.0.0.1:7861",
  ocrOllamaModel: "glm-ocr",
  pdfOcrDefaultMode: "sentence",
  pdfOcrReviewBeforeAnalyze: false,
  autoTrigger: true,
  triggerModifier: "ctrl",
  triggerDelayMs: 300,
  maxSelectionCharacters: 500,
  requestTimeoutSeconds: 60,
  cacheSize: 60,
};
const DEEPSEEK_SECRET_ID = "japanese-reading-assistant-deepseek-key";
const PDF_OCR_VIEW_TYPE = "japanese-reading-assistant-pdf-ocr";

type AutomaticSelectionSource = "editor" | "preview";

export class PdfOcrControlView extends ItemView {
  private status = "待命：在 PDF 页面按住 Alt 并拖动框选。";

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: JapaneseReadingAssistantPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return PDF_OCR_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "日语阅读助手";
  }

  getIcon(): string {
    return "scan-text";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  setStatus(status: string): void {
    this.status = status;
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("jra-pdf-ocr-panel");
    contentEl.createEl("h4", { text: "日语阅读助手" });
    contentEl.createEl("p", {
      text: "Ctrl + 拖选日文：文字解析。Alt + 拖框 PDF：OCR 解析。Alt + M：显示此面板。",
      cls: "setting-item-description",
    });
    const modeLabel = contentEl.createEl("label", {
      text: "识别后默认操作",
      cls: "jra-pdf-ocr-panel__label",
    });
    const mode = contentEl.createEl("select", {
      cls: "dropdown jra-pdf-ocr-panel__mode",
    });
    mode.setAttr("aria-label", "PDF OCR 默认解析方式");
    mode.createEl("option", { value: "sentence", text: "句子解析" });
    mode.createEl("option", { value: "word", text: "词语翻译" });
    mode.value = this.plugin.settings.pdfOcrDefaultMode;
    mode.addEventListener("change", () => {
      this.plugin.settings.pdfOcrDefaultMode = mode.value as AnalysisMode;
      void this.plugin.saveSettings();
      this.setStatus(
        `已设为默认${mode.value === "sentence" ? "句子解析" : "词语翻译"}。`,
      );
    });
    modeLabel.appendChild(mode);

    const reviewLabel = contentEl.createEl("label", {
      cls: "jra-pdf-ocr-panel__review",
    });
    const review = reviewLabel.createEl("input", { type: "checkbox" });
    review.checked = this.plugin.settings.pdfOcrReviewBeforeAnalyze;
    review.addEventListener("change", () => {
      this.plugin.settings.pdfOcrReviewBeforeAnalyze = review.checked;
      void this.plugin.saveSettings();
      this.setStatus(
        review.checked ? "OCR 后会先显示校对文本。" : "OCR 后会直接进入默认解析。",
      );
    });
    reviewLabel.appendText(" OCR 后先校对文本");

    const ocrButton = contentEl.createEl("button", {
      text: "OCR 框选并解析",
      cls: "mod-cta jra-pdf-ocr-panel__button",
    });
    ocrButton.addEventListener("click", () => {
      void this.plugin.startPdfOcrFromPanel();
    });
    contentEl.createEl("p", {
      text: this.status,
      cls: "jra-pdf-ocr-panel__status",
    });
  }
}

interface CompletedModifierGesture {
  modifierAllowed: boolean;
  source: AutomaticSelectionSource;
  root: Element;
}

class ResultCache {
  private readonly values = new Map<string, AnalysisResult>();

  get(key: string): AnalysisResult | undefined {
    const value = this.values.get(key);
    if (!value) {
      return undefined;
    }
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key: string, value: AnalysisResult, maximum: number): void {
    if (maximum <= 0) {
      return;
    }
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > maximum) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      this.values.delete(oldest);
    }
  }

  clear(): void {
    this.values.clear();
  }
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function boundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric)
    ? Math.max(minimum, Math.min(maximum, numeric))
    : fallback;
}

function normalizeLoadedSettings(rawValue: unknown): JapaneseReadingSettings {
  const raw =
    typeof rawValue === "object" && rawValue !== null
      ? (rawValue as Record<string, unknown>)
      : {};
  const legacyModel = stringValue(raw.deepseekModel ?? raw.model, "");
  const deepseekModel =
    legacyModel === "deepseek-chat" || legacyModel === "deepseek-reasoner"
      ? "deepseek-v4-flash"
      : legacyModel || DEFAULT_SETTINGS.deepseekModel;
  const savedSchema = Number(raw.schemaVersion);
  const modifier = savedSchema >= 6 ? raw.triggerModifier : "ctrl";

  return {
    schemaVersion: 6,
    provider:
      raw.provider === "deepseek" || raw.provider === "ollama"
        ? raw.provider
        : DEFAULT_SETTINGS.provider,
    deepseekApiKey: stringValue(
      raw.deepseekApiKey ?? raw.apiKey,
      DEFAULT_SETTINGS.deepseekApiKey,
    ),
    deepseekBaseUrl: stringValue(
      raw.deepseekBaseUrl ?? raw.apiBase,
      DEFAULT_SETTINGS.deepseekBaseUrl,
    ),
    deepseekModel,
    ollamaBaseUrl: stringValue(
      raw.ollamaBaseUrl,
      DEFAULT_SETTINGS.ollamaBaseUrl,
    ),
    ollamaModel: stringValue(raw.ollamaModel, DEFAULT_SETTINGS.ollamaModel),
    ocrProvider: raw.ocrProvider === "ollama" ? "ollama" : "paddle",
    paddleOcrBaseUrl: stringValue(
      raw.paddleOcrBaseUrl,
      DEFAULT_SETTINGS.paddleOcrBaseUrl,
    ),
    ocrOllamaModel: stringValue(
      raw.ocrOllamaModel,
      DEFAULT_SETTINGS.ocrOllamaModel,
    ),
    pdfOcrDefaultMode:
      raw.pdfOcrDefaultMode === "word" || raw.pdfOcrDefaultMode === "sentence"
        ? raw.pdfOcrDefaultMode
        : DEFAULT_SETTINGS.pdfOcrDefaultMode,
    pdfOcrReviewBeforeAnalyze:
      typeof raw.pdfOcrReviewBeforeAnalyze === "boolean"
        ? raw.pdfOcrReviewBeforeAnalyze
        : DEFAULT_SETTINGS.pdfOcrReviewBeforeAnalyze,
    autoTrigger:
      typeof raw.autoTrigger === "boolean"
        ? raw.autoTrigger
        : DEFAULT_SETTINGS.autoTrigger,
    triggerModifier:
      modifier === "ctrl" ||
      modifier === "alt" ||
      modifier === "shift" ||
      modifier === "none"
        ? modifier
        : DEFAULT_SETTINGS.triggerModifier,
    triggerDelayMs: boundedNumber(
      raw.triggerDelayMs,
      DEFAULT_SETTINGS.triggerDelayMs,
      150,
      800,
    ),
    maxSelectionCharacters: boundedNumber(
      raw.maxSelectionCharacters,
      DEFAULT_SETTINGS.maxSelectionCharacters,
      20,
      2000,
    ),
    requestTimeoutSeconds: boundedNumber(
      raw.requestTimeoutSeconds,
      DEFAULT_SETTINGS.requestTimeoutSeconds,
      15,
      120,
    ),
    cacheSize: boundedNumber(
      raw.cacheSize,
      DEFAULT_SETTINGS.cacheSize,
      0,
      200,
    ),
  };
}

function rectToPlain(rect: DOMRect | DOMRectReadOnly): RectLike {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function centerAnchor(document: Document): RectLike {
  const view = document.defaultView;
  const x = (view?.innerWidth ?? 800) / 2;
  const y = (view?.innerHeight ?? 600) / 3;
  return {
    left: x,
    right: x,
    top: y,
    bottom: y,
    width: 0,
    height: 0,
  };
}

export default class JapaneseReadingAssistantPlugin extends Plugin {
  settings: JapaneseReadingSettings = { ...DEFAULT_SETTINGS };

  private popup: FloatingResultPopup | null = null;
  private readonly cache = new ResultCache();
  private readonly inFlight = new Map<string, Promise<AnalysisResult>>();
  private readonly documentComponents = new Map<Document, Component>();
  private readonly modifiers = new WeakMap<Document, ModifierSnapshot>();
  private readonly modifierGestures = new WeakMap<Document, ModifierGesture>();
  private readonly modifierGestureRoots = new WeakMap<Document, Element>();
  private readonly editorSelectionContexts =
    new WeakMap<Document, SelectionContext>();
  private selectionTimer: ReturnType<typeof setTimeout> | null = null;
  private selectionTimerSource: AutomaticSelectionSource | null = null;
  private selectionTimerSignature = "";
  private selectionTimerExplicitlyAuthorized = false;
  private requestGeneration = 0;
  private lastContext: SelectionContext | null = null;
  private lastMode: AnalysisMode | null = null;
  private lastScheduledSignature = "";

  async onload(): Promise<void> {
    const rawSettings = await this.loadData();
    this.settings = normalizeLoadedSettings(rawSettings);
    const storedApiKey = this.app.secretStorage.getSecret(DEEPSEEK_SECRET_ID);
    if (storedApiKey !== null) {
      this.settings.deepseekApiKey = storedApiKey;
    } else if (this.settings.deepseekApiKey) {
      this.app.secretStorage.setSecret(
        DEEPSEEK_SECRET_ID,
        this.settings.deepseekApiKey,
      );
    }
    if (
      typeof rawSettings === "object" &&
      rawSettings !== null &&
      ("apiKey" in rawSettings || "deepseekApiKey" in rawSettings)
    ) {
      await this.persistNonSecretSettings();
    }
    this.popup = new FloatingResultPopup({
      onClose: () => this.cancelPending(),
      onModeChange: (mode) => {
        if (this.lastContext) {
          void this.runAnalysis(this.lastContext, mode);
        }
      },
      onRetry: () => {
        if (this.lastContext && this.lastMode) {
          void this.runAnalysis(this.lastContext, this.lastMode, true);
        }
      },
    });

    this.app.workspace.detachLeavesOfType(PDF_OCR_VIEW_TYPE);
    this.addSettingTab(new JapaneseReadingSettingTab(this.app, this));
    this.registerCommands();
    this.registerEditorExtension(
      createEditorSelectionExtension(
        (context) => {
          if (context) {
            this.editorSelectionContexts.set(context.document, context);
            this.scheduleAutomaticAnalysis(context, "editor");
          } else {
            this.clearSelectionTimer("editor");
          }
        },
        () =>
          this.settings.autoTrigger &&
          this.settings.triggerModifier === "alt" &&
          !this.popup?.isPinned(),
      ),
    );

    this.registerDocument(document);
    this.app.workspace.iterateAllLeaves((leaf) => {
      this.registerDocument(leaf.view.containerEl.ownerDocument);
    });
    this.registerEvent(
      this.app.workspace.on("window-open", (_workspaceWindow, window) => {
        this.registerDocument(window.document);
      }),
    );
    this.registerEvent(
      this.app.workspace.on("window-close", (_workspaceWindow, window) => {
        const closedDocument = window.document;
        this.clearSelectionTimer();
        if (this.popup?.ownsDocument(closedDocument)) {
          this.popup.close();
        }
        this.unregisterDocument(closedDocument);
      }),
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.closeUnpinnedPopup()),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => this.closeUnpinnedPopup()),
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.closeUnpinnedPopup()),
    );
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        this.addEditorMenuItems(menu, editor);
      }),
    );
  }

  onunload(): void {
    this.cancelPending();
    this.popup?.destroy();
    this.popup = null;
    this.cache.clear();
    this.inFlight.clear();
    this.documentComponents.clear();
  }

  async saveSettings(): Promise<void> {
    this.app.secretStorage.setSecret(
      DEEPSEEK_SECRET_ID,
      this.settings.deepseekApiKey,
    );
    await this.persistNonSecretSettings();
    this.cache.clear();
  }

  clearCache(): void {
    this.cache.clear();
  }

  async testCurrentProvider(): Promise<string> {
    try {
      const result = await analyzeJapanese(this.settings, "猫", "word");
      return result.translation;
    } catch (error) {
      throw new Error(
        humanizeError(error, this.providerLabel()),
        error instanceof Error ? { cause: error } : undefined,
      );
    }
  }

  async refreshProviderModels(): Promise<string[]> {
    try {
      return this.settings.provider === "ollama"
        ? await listOllamaModels(this.settings)
        : await listDeepSeekModels(this.settings);
    } catch (error) {
      throw new Error(
        humanizeError(error, this.providerLabel()),
        error instanceof Error ? { cause: error } : undefined,
      );
    }
  }

  private registerCommands(): void {
    this.addCommand({
      id: "analyze-selection",
      name: "翻译并自动判断词语 / 句子",
      icon: "languages",
      checkCallback: (checking) => {
        const context = this.readActiveSelection();
        if (!checking && context) {
          void this.runAnalysis(context);
        }
        return Boolean(context);
      },
    });

    this.addCommand({
      id: "translate-selection-as-word",
      name: "把选中内容作为词语翻译",
      icon: "whole-word",
      checkCallback: (checking) => {
        const context = this.readActiveSelection();
        if (!checking && context) {
          void this.runAnalysis(context, "word");
        }
        return Boolean(context);
      },
    });

    this.addCommand({
      id: "analyze-selection-as-sentence",
      name: "把选中内容作为句子翻译并解析",
      icon: "text-quote",
      checkCallback: (checking) => {
        const context = this.readActiveSelection();
        if (!checking && context) {
          void this.runAnalysis(context, "sentence");
        }
        return Boolean(context);
      },
    });

    this.addCommand({
      id: "ocr-pdf-region",
      name: "框选 PDF 区域并 OCR 解析",
      icon: "scan-text",
      checkCallback: (checking) => {
        const containerEl = this.activePdfContainer();
        if (!containerEl || !findPdfPageCanvas(containerEl)) {
          return false;
        }
        if (!checking) {
          void this.runPdfOcr(containerEl);
        }
        return true;
      },
    });

    this.addCommand({
      id: "open-pdf-ocr-panel",
      name: "打开日语阅读助手",
      icon: "languages",
      callback: () => void this.openAssistantComposer(),
    });

    this.addCommand({
      id: "toggle-auto-trigger",
      name: "切换划选后自动查询",
      icon: "mouse-pointer-click",
      callback: async () => {
        this.settings.autoTrigger = !this.settings.autoTrigger;
        await this.saveSettings();
        new Notice(
          `日语阅读助手：自动查询已${this.settings.autoTrigger ? "开启" : "关闭"}`,
        );
      },
    });
  }

  private addEditorMenuItems(menu: Menu, editor: Editor): void {
    const text = editor.getSelection().trim();
    if (!text) {
      return;
    }
    menu.addSeparator();
    menu.addItem((item) => {
      item
        .setTitle("日语阅读助手：自动判断")
        .setIcon("languages")
        .onClick(() => this.runEditorSelection(editor));
    });
    menu.addItem((item) => {
      item
        .setTitle("日语阅读助手：按句子解析")
        .setIcon("text-quote")
        .onClick(() => this.runEditorSelection(editor, "sentence"));
    });
  }

  private registerDocument(document: Document): void {
    if (this.documentComponents.has(document)) {
      return;
    }
    const component = this.addChild(new Component());
    this.documentComponents.set(document, component);
    this.modifiers.set(document, { ctrl: false, alt: false, shift: false });

    component.registerDomEvent(document, "selectionchange", () => {
      const context = this.readPreviewSelection(document);
      if (context) {
        this.scheduleAutomaticAnalysis(context, "preview");
      } else {
        this.clearSelectionTimer("preview");
      }
    });

    component.registerDomEvent(
      document,
      "pointerup",
      (event: PointerEvent) => {
        if (event.button !== 0 || !event.isPrimary) {
          return;
        }
        const completed = this.finishModifierGesture(document, event);
        if (!completed) {
          return;
        }
        document.defaultView?.queueMicrotask(() => {
          const context =
            completed.source === "preview"
              ? this.readPreviewSelection(document, completed.root)
              : this.readEditorSelectionAtRoot(
                  document,
                  completed.root,
                );
          if (context) {
            this.scheduleAutomaticAnalysis(
              context,
              completed.source,
              completed.modifierAllowed,
            );
          } else {
            this.clearSelectionTimer(completed.source);
          }
        });
      },
      true,
    );

    component.registerDomEvent(
      document,
      "keydown",
      (event: KeyboardEvent) => {
        this.updateModifierState(document, event);
        if (
          event.altKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.metaKey &&
          event.key.toLowerCase() === "m"
        ) {
          event.preventDefault();
          event.stopPropagation();
          void this.openAssistantComposer();
          return;
        }
        if (event.key === "Escape" && this.popup?.isOpen()) {
          this.popup.close();
        }
      },
      true,
    );

    component.registerDomEvent(
      document,
      "keyup",
      (event: KeyboardEvent) => {
        this.updateModifierState(document, event);
      },
      true,
    );

    component.registerDomEvent(
      document,
      "pointerdown",
      (event: PointerEvent) => {
        const target = event.target as Node | null;
        this.updateModifierState(document, event);
        const pdfContainer = this.findPdfContainer(target, document);
        if (
          pdfContainer &&
          event.button === 0 &&
          event.isPrimary &&
          event.altKey &&
          this.settings.autoTrigger
        ) {
          event.preventDefault();
          event.stopPropagation();
          void this.runPdfOcr(pdfContainer, event);
          return;
        }
        const surface = this.findMarkdownSelectionSurface(target);
        this.modifierGestures.delete(document);
        this.modifierGestureRoots.delete(document);
        if (
          event.button === 0 &&
          event.isPrimary &&
          surface
        ) {
          this.beginModifierGesture(
            document,
            event,
            surface.source,
            surface.root,
          );
        }
        if (!this.popup?.contains(target) && !this.popup?.isPinned()) {
          this.closeUnpinnedPopup();
        }
      },
      true,
    );

    component.registerDomEvent(
      document,
      "pointercancel",
      (event: PointerEvent) => {
        const gesture = this.modifierGestures.get(document);
        if (event.isPrimary && gesture?.pointerId === event.pointerId) {
          this.modifierGestures.delete(document);
          this.modifierGestureRoots.delete(document);
          this.clearSelectionTimer();
        }
      },
      true,
    );

    component.registerDomEvent(
      document,
      "scroll",
      (event: Event) => {
        const target = event.target as Node | null;
        if (!this.popup?.contains(target) && !this.popup?.isPinned()) {
          this.closeUnpinnedPopup();
        }
      },
      true,
    );

    const view = document.defaultView;
    if (view) {
      component.registerDomEvent(view, "resize", () => this.closeUnpinnedPopup());
      component.registerDomEvent(view, "blur", () => {
        const hadActiveGesture = this.modifierGestures.has(document);
        this.modifiers.set(document, { ctrl: false, alt: false, shift: false });
        this.modifierGestures.delete(document);
        this.modifierGestureRoots.delete(document);
        if (hadActiveGesture) {
          this.clearSelectionTimer();
        }
      });
    }
  }

  private unregisterDocument(document: Document): void {
    const component = this.documentComponents.get(document);
    if (!component) {
      return;
    }
    this.documentComponents.delete(document);
    this.modifiers.delete(document);
    this.modifierGestures.delete(document);
    this.modifierGestureRoots.delete(document);
    this.editorSelectionContexts.delete(document);
    this.removeChild(component);
  }

  private snapshotModifiers(
    event: MouseEvent | KeyboardEvent,
  ): ModifierSnapshot {
    return {
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
    };
  }

  private updateModifierState(
    document: Document,
    event: MouseEvent | KeyboardEvent,
  ): void {
    this.modifiers.set(document, this.snapshotModifiers(event));
  }

  private beginModifierGesture(
    document: Document,
    event: PointerEvent,
    source: AutomaticSelectionSource,
    root: Element,
  ): void {
    const state = this.snapshotModifiers(event);
    this.modifiers.set(document, state);
    this.modifierGestures.set(document, {
      pointerId: event.pointerId,
      source,
      state,
      expiresAt:
        Date.now() + Math.max(10000, this.settings.triggerDelayMs + 1500),
    });
    this.modifierGestureRoots.set(document, root);
  }

  private finishModifierGesture(
    document: Document,
    event: PointerEvent,
  ): CompletedModifierGesture | null {
    const current = this.snapshotModifiers(event);
    this.modifiers.set(document, current);
    const gesture = this.modifierGestures.get(document);
    const root = this.modifierGestureRoots.get(document);
    if (
      !gesture ||
      gesture.pointerId !== event.pointerId ||
      !root
    ) {
      if (gesture?.pointerId === event.pointerId) {
        this.modifierGestures.delete(document);
        this.modifierGestureRoots.delete(document);
      }
      return null;
    }
    this.modifierGestures.delete(document);
    this.modifierGestureRoots.delete(document);
    return {
      modifierAllowed: isTriggerModifierSatisfied(
        this.settings.triggerModifier,
        undefined,
        gesture,
      ),
      source: gesture.source,
      root,
    };
  }

  private modifierSatisfied(document: Document): boolean {
    return isTriggerModifierSatisfied(
      this.settings.triggerModifier,
      this.modifiers.get(document),
      this.modifierGestures.get(document),
    );
  }

  private scheduleAutomaticAnalysis(
    context: SelectionContext,
    source: AutomaticSelectionSource,
    modifierAllowed?: boolean,
  ): void {
    if (!this.settings.autoTrigger || this.popup?.isPinned()) {
      this.clearSelectionTimer(source);
      return;
    }

    const text = normalizeSelection(context.text);
    if (
      !text ||
      !isLikelyJapaneseSelection(text, context.surroundingText ?? "")
    ) {
      this.clearSelectionTimer(source);
      return;
    }
    if (
      modifierAllowed === undefined &&
      this.modifierGestures.has(context.document)
    ) {
      return;
    }

    const pendingSignature = [
      context.document.URL,
      source,
      Math.round(context.anchor.left),
      Math.round(context.anchor.top),
      Math.round(context.anchor.right),
      Math.round(context.anchor.bottom),
      text,
    ].join("|");
    if (
      modifierAllowed === undefined &&
      this.selectionTimer &&
      this.selectionTimerExplicitlyAuthorized &&
      this.selectionTimerSource === source &&
      this.selectionTimerSignature === pendingSignature
    ) {
      return;
    }
    const modifierSatisfied =
      modifierAllowed ?? this.modifierSatisfied(context.document);
    if (!modifierSatisfied) {
      this.clearSelectionTimer(source);
      return;
    }

    const completedSignature = `${context.document.URL}|${text}`;
    if (
      completedSignature === this.lastScheduledSignature &&
      this.popup?.isOpen()
    ) {
      return;
    }

    this.clearSelectionTimer();
    this.selectionTimerSource = source;
    this.selectionTimerSignature = pendingSignature;
    this.selectionTimerExplicitlyAuthorized = modifierAllowed === true;
    this.selectionTimer = setTimeout(() => {
      this.selectionTimer = null;
      this.selectionTimerSource = null;
      this.selectionTimerSignature = "";
      this.selectionTimerExplicitlyAuthorized = false;
      if (
        !this.settings.autoTrigger ||
        this.popup?.isPinned()
      ) {
        return;
      }
      this.lastScheduledSignature = completedSignature;
      void this.runAnalysis({ ...context, text });
    }, this.settings.triggerDelayMs);
  }

  private readPreviewSelection(
    document: Document,
    expectedRoot?: Element,
  ): SelectionContext | null {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return null;
    }
    const range = selection.getRangeAt(0);
    if (
      this.popup?.contains(range.commonAncestorContainer) ||
      (expectedRoot
        ? !expectedRoot.contains(range.commonAncestorContainer)
        : !this.isRangeInMarkdownPreview(range))
    ) {
      return null;
    }

    const text = normalizeSelection(selection.toString());
    if (!text) {
      return null;
    }

    let anchorRect: DOMRect | DOMRectReadOnly | null = null;
    if (selection.focusNode) {
      try {
        const focusRange = document.createRange();
        focusRange.setStart(selection.focusNode, selection.focusOffset);
        focusRange.collapse(true);
        const focusRect = focusRange.getBoundingClientRect();
        if (focusRect.width || focusRect.height) {
          anchorRect = focusRect;
        }
      } catch {
        anchorRect = null;
      }
    }

    if (!anchorRect) {
      const rectangles = Array.from(range.getClientRects()).filter(
        (rect) => rect.width || rect.height,
      );
      anchorRect =
        rectangles.at(-1) ?? range.getBoundingClientRect() ?? centerAnchor(document);
    }

    return {
      text,
      anchor:
        "toJSON" in anchorRect
          ? rectToPlain(anchorRect)
          : (anchorRect as RectLike),
      document,
      surroundingText: this.previewSurroundingText(range),
    };
  }

  private previewSurroundingText(range: Range): string {
    const ancestor = range.commonAncestorContainer;
    const element =
      ancestor.nodeType === 1
        ? (ancestor as Element)
        : ancestor.parentElement;
    const block = element?.closest(
      "p, li, blockquote, td, th, h1, h2, h3, h4, h5, h6",
    );
    return (block?.textContent ?? element?.textContent ?? "").slice(0, 500);
  }

  private isRangeInMarkdownPreview(range: Range): boolean {
    return this.isNodeInMarkdownPreview(range.commonAncestorContainer);
  }

  private isNodeInMarkdownPreview(node: Node | null): boolean {
    if (!node) {
      return false;
    }
    let inside = false;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (inside || !(leaf.view instanceof MarkdownView)) {
        return;
      }
      const container = leaf.view.previewMode.containerEl;
      if (container.contains(node)) {
        inside = true;
      }
    });
    return inside;
  }

  private findMarkdownSelectionSurface(
    node: Node | null,
  ): { source: AutomaticSelectionSource; root: Element } | null {
    if (!node) {
      return null;
    }
    let surface: {
      source: AutomaticSelectionSource;
      root: Element;
    } | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (surface || !(leaf.view instanceof MarkdownView)) {
        return;
      }
      const editorRoot = leaf.view.containerEl.querySelector(".cm-editor");
      if (editorRoot?.contains(node)) {
        surface = { source: "editor", root: editorRoot };
        return;
      }
      const previewRoot = leaf.view.previewMode.containerEl;
      if (previewRoot.contains(node)) {
        surface = { source: "preview", root: previewRoot };
      }
    });
    return surface;
  }

  private readEditorSelectionAtRoot(
    document: Document,
    expectedRoot: Element,
  ): SelectionContext | null {
    let context: SelectionContext | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (context || !(leaf.view instanceof MarkdownView)) {
        return;
      }
      const view = leaf.view;
      const editorRoot = view.containerEl.querySelector(".cm-editor");
      if (
        view.containerEl.ownerDocument !== document ||
        editorRoot !== expectedRoot
      ) {
        return;
      }
      const text = normalizeSelection(view.editor.getSelection());
      if (text) {
        const observed = this.editorSelectionContexts.get(document);
        context = {
          ...(observed && normalizeSelection(observed.text) === text
            ? observed
            : {
                text,
                anchor: centerAnchor(document),
                document,
              }),
          text,
        };
      }
    });
    return context;
  }

  private readActiveSelection(): SelectionContext | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      return null;
    }
    const document = view.containerEl.ownerDocument;

    if (view.getMode() === "preview") {
      return this.readPreviewSelection(document);
    }

    const text = normalizeSelection(view.editor.getSelection());
    if (!text) {
      return null;
    }
    return {
      text,
      anchor: centerAnchor(document),
      document,
    };
  }

  private activePdfContainer(): HTMLElement | null {
    const leaf = this.app.workspace.activeLeaf;
    return leaf?.view.getViewType() === "pdf" ? leaf.view.containerEl : null;
  }

  private async openAssistantComposer(): Promise<void> {
    const activeDocument =
      this.app.workspace.activeLeaf?.view.containerEl.ownerDocument ?? document;
    const selected = this.readActiveSelection();
    const context: SelectionContext = selected ?? {
      text: "",
      anchor: centerAnchor(activeDocument),
      document: activeDocument,
    };
    const ocr = await checkPaddleOcrService(this.settings);
    this.popup?.showComposer(context, {
      initialText: context.text,
      ocrOnline: ocr.online,
      ocrMessage: ocr.message,
      onAnalyze: (text) => {
        void this.runAnalysis({ ...context, text }, "sentence");
      },
      onRestartOcr: () => {
        void this.restartOcrFromComposer();
      },
    });
  }

  private async restartOcrFromComposer(): Promise<void> {
    try {
      await restartPaddleOcrService(this.settings);
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 1000));
        const ocr = await checkPaddleOcrService(this.settings);
        if (ocr.online) {
          break;
        }
      }
      await this.openAssistantComposer();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`OCR 重启失败：${message}`, 7000);
      await this.openAssistantComposer();
    }
  }

  async startPdfOcrFromPanel(): Promise<void> {
    const containerEl = this.activePdfContainer();
    if (!containerEl) {
      this.setPdfOcrStatus("请先打开一个 PDF 页面，再开始框选。");
      new Notice("请先打开一个 PDF 页面。");
      return;
    }
    await this.runPdfOcr(containerEl);
  }

  private setPdfOcrStatus(status: string): void {
    for (const leaf of this.app.workspace.getLeavesOfType(PDF_OCR_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof PdfOcrControlView) {
        view.setStatus(status);
      }
    }
  }

  private findPdfContainer(
    target: Node | null,
    document: Document,
  ): HTMLElement | null {
    if (!target) {
      return null;
    }
    let container: HTMLElement | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (
        container ||
        leaf.view.getViewType() !== "pdf" ||
        leaf.view.containerEl.ownerDocument !== document ||
        !leaf.view.containerEl.contains(target)
      ) {
        return;
      }
      if (findPdfPageCanvas(leaf.view.containerEl)) {
        container = leaf.view.containerEl;
      }
    });
    return container;
  }

  private async runPdfOcr(
    containerEl: HTMLElement,
    initialPointerEvent?: PointerEvent,
  ): Promise<void> {
    try {
      this.setPdfOcrStatus(
        initialPointerEvent ? "正在框选 PDF 区域…" : "请在 PDF 页面拖动框选日文。",
      );
      const crop = await capturePdfRegion(containerEl, initialPointerEvent);
      const ocrLabel =
        this.settings.ocrProvider === "paddle" ? "PP-OCRv5" : "本地 Ollama";
      this.setPdfOcrStatus(`正在用 ${ocrLabel} 识别正文…`);
      new Notice(`正在通过 ${ocrLabel} OCR 识别正文…`);
      const text = await recognizeJapaneseFromImage(
        this.settings,
        crop.imageBase64,
      );
      this.setPdfOcrStatus("已识别，正在生成词汇与语法解析…");
      void this.runAnalysis(
        {
          text,
          anchor: crop.anchor,
          document: crop.document,
        },
        "sentence",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== "已取消 PDF 框选。") {
        this.setPdfOcrStatus(`OCR 未完成：${message}`);
        new Notice(`PDF OCR：${message}`, 7000);
      } else {
        this.setPdfOcrStatus("已取消框选。");
      }
    }
  }

  private runEditorSelection(editor: Editor, forcedMode?: AnalysisMode): void {
    const document =
      this.app.workspace.getActiveViewOfType(MarkdownView)?.containerEl
        .ownerDocument ?? window.document;
    const text = normalizeSelection(editor.getSelection());
    if (!text) {
      new Notice("请先选中日语词语或句子。");
      return;
    }
    void this.runAnalysis(
      {
        text,
        anchor: centerAnchor(document),
        document,
      },
      forcedMode,
    );
  }

  private async runAnalysis(
    context: SelectionContext,
    forcedMode?: AnalysisMode,
    bypassDuplicate = false,
  ): Promise<void> {
    const text = normalizeSelection(context.text);
    if (!text) {
      return;
    }
    const mode = forcedMode ?? classifySelection(text);
    const normalizedContext = { ...context, text };
    this.lastContext = normalizedContext;
    this.lastMode = mode;
    const generation = ++this.requestGeneration;

    if (!containsJapanese(text)) {
      this.popup?.showLoading(normalizedContext, mode);
      this.popup?.showError("选中内容里没有检测到日文。");
      return;
    }
    if (Array.from(text).length > this.settings.maxSelectionCharacters) {
      this.popup?.showLoading(normalizedContext, mode);
      this.popup?.showError(
        `选区超过 ${this.settings.maxSelectionCharacters} 个字符，请缩小范围。`,
      );
      return;
    }
    if (
      this.settings.provider === "deepseek" &&
      !this.settings.deepseekApiKey.trim()
    ) {
      this.popup?.showLoading(normalizedContext, mode);
      this.popup?.showError(
        "尚未配置 DeepSeek API Key。请打开 设置 → 日语阅读助手。",
      );
      return;
    }

    const cacheKey = this.cacheKey(text, mode);
    const cached = this.cache.get(cacheKey);
    this.popup?.showLoading(normalizedContext, mode);

    if (cached && !bypassDuplicate) {
      this.popup?.showResult(cached);
      return;
    }

    try {
      const result = await this.getOrCreateRequest(cacheKey, text, mode);
      if (generation !== this.requestGeneration || !this.popup?.isOpen()) {
        return;
      }
      this.cache.set(cacheKey, result, this.settings.cacheSize);
      this.popup.showResult(result);
    } catch (error) {
      if (generation !== this.requestGeneration || !this.popup?.isOpen()) {
        return;
      }
      this.popup.showError(humanizeError(error, this.providerLabel()));
    }
  }

  private cacheKey(text: string, mode: AnalysisMode): string {
    const model =
      this.settings.provider === "ollama"
        ? this.settings.ollamaModel
        : this.settings.deepseekModel;
    const endpoint =
      this.settings.provider === "ollama"
        ? this.settings.ollamaBaseUrl
        : this.settings.deepseekBaseUrl;
    return `${this.settings.provider}|${endpoint}|${model}|${mode}|${text}`;
  }

  private getOrCreateRequest(
    cacheKey: string,
    text: string,
    mode: AnalysisMode,
  ): Promise<AnalysisResult> {
    const existing = this.inFlight.get(cacheKey);
    if (existing) {
      return existing;
    }

    const request = analyzeJapanese(this.settings, text, mode);
    this.inFlight.set(cacheKey, request);
    void request.then(
      () => {
        if (this.inFlight.get(cacheKey) === request) {
          this.inFlight.delete(cacheKey);
        }
      },
      () => {
        if (this.inFlight.get(cacheKey) === request) {
          this.inFlight.delete(cacheKey);
        }
      },
    );
    return request;
  }

  private providerLabel(): string {
    return this.settings.provider === "ollama" ? "Ollama" : "DeepSeek";
  }

  private async persistNonSecretSettings(): Promise<void> {
    const persisted = { ...this.settings } as Record<string, unknown>;
    delete persisted.deepseekApiKey;
    await this.saveData(persisted);
  }

  private closeUnpinnedPopup(): void {
    this.clearSelectionTimer();
    if (this.popup?.isOpen() && !this.popup.isPinned()) {
      this.popup.close();
    }
  }

  private cancelPending(): void {
    this.clearSelectionTimer();
    this.requestGeneration += 1;
    this.lastScheduledSignature = "";
    this.lastContext = null;
    this.lastMode = null;
  }

  private clearSelectionTimer(source?: AutomaticSelectionSource): void {
    if (!this.selectionTimer) {
      return;
    }
    if (source && this.selectionTimerSource !== source) {
      return;
    }
    clearTimeout(this.selectionTimer);
    this.selectionTimer = null;
    this.selectionTimerSource = null;
    this.selectionTimerSignature = "";
    this.selectionTimerExplicitlyAuthorized = false;
  }
}
