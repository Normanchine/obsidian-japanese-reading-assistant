import { Platform, setIcon } from "obsidian";
import type {
  AnalysisMode,
  AnalysisResult,
  GrammarPoint,
  RectLike,
  SelectionContext,
  SentenceAnalysisResult,
} from "./types";

export interface PopupHandlers {
  onClose: () => void;
  onModeChange: (mode: AnalysisMode) => void;
  onRetry: () => void;
}

export interface AssistantComposerOptions {
  initialText: string;
  ocrOnline: boolean;
  ocrMessage: string;
  onAnalyze: (text: string) => void;
  onRestartOcr: () => void;
}

type PopupState = "loading" | "result" | "error" | "composer";

export class FloatingResultPopup {
  private root: HTMLDivElement | null = null;
  private content: HTMLDivElement | null = null;
  private sourceText: HTMLDivElement | null = null;
  private modeButtons = new Map<AnalysisMode, HTMLButtonElement>();
  private pinButton: HTMLButtonElement | null = null;
  private ownerDocument: Document | null = null;
  private context: SelectionContext | null = null;
  private mode: AnalysisMode = "word";
  private pinned = false;
  private manuallyPositioned = false;
  private state: PopupState = "loading";
  private currentResult: AnalysisResult | null = null;
  private composerOptions: AssistantComposerOptions | null = null;
  private dragCleanup: (() => void) | null = null;

  constructor(private readonly handlers: PopupHandlers) {}

  isOpen(): boolean {
    return Boolean(this.root?.isConnected);
  }

  isPinned(): boolean {
    return this.pinned;
  }

  ownsDocument(document: Document): boolean {
    return this.ownerDocument === document;
  }

  contains(node: Node | null): boolean {
    return Boolean(node && this.root?.contains(node));
  }

  showLoading(context: SelectionContext, mode: AnalysisMode): void {
    const keepPosition =
      this.ownerDocument === context.document &&
      this.isOpen() &&
      (this.pinned || this.manuallyPositioned);
    this.ensureRoot(context.document);
    this.context = context;
    this.mode = mode;
    this.state = "loading";
    this.currentResult = null;
    this.composerOptions = null;
    this.manuallyPositioned = keepPosition;
    this.renderShell();
    this.renderLoading();
    if (!keepPosition) {
      this.position(context.anchor);
    }
  }

  showComposer(
    context: SelectionContext,
    options: AssistantComposerOptions,
  ): void {
    this.ensureRoot(context.document);
    this.context = context;
    this.mode = "sentence";
    this.state = "composer";
    this.currentResult = null;
    this.composerOptions = options;
    this.manuallyPositioned = false;
    this.renderShell();
    this.renderComposer();
    this.position(context.anchor);
    this.root?.focus();
  }

  showResult(result: AnalysisResult): void {
    if (!this.root || !this.context) {
      return;
    }
    this.state = "result";
    this.currentResult = result;
    this.mode = result.kind;
    this.updateModeButtons();
    this.renderResult(result);
    if (!this.manuallyPositioned) {
      this.position(this.context.anchor);
    }
  }

  showError(message: string): void {
    if (!this.root || !this.context) {
      return;
    }
    this.state = "error";
    this.renderError(message);
    if (!this.manuallyPositioned) {
      this.position(this.context.anchor);
    }
  }

  close(notify = true): void {
    this.dragCleanup?.();
    this.dragCleanup = null;
    this.root?.remove();
    this.root = null;
    this.content = null;
    this.sourceText = null;
    this.pinButton = null;
    this.modeButtons.clear();
    this.ownerDocument = null;
    this.context = null;
    this.currentResult = null;
    this.composerOptions = null;
    this.pinned = false;
    this.manuallyPositioned = false;
    if (notify) {
      this.handlers.onClose();
    }
  }

  destroy(): void {
    this.close(false);
  }

  private ensureRoot(document: Document): void {
    if (this.root?.isConnected && this.ownerDocument === document) {
      return;
    }
    this.close(false);
    this.ownerDocument = document;
    this.root = document.createElement("div");
    this.root.className = "jra-popup";
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", "日语阅读助手");
    this.root.tabIndex = -1;
    document.body.append(this.root);
  }

  private renderShell(): void {
    if (!this.root || !this.context) {
      return;
    }
    this.root.replaceChildren();
    this.root.classList.toggle("is-pinned", this.pinned);

    const header = this.ownerDocument!.createElement("div");
    header.className = "jra-popup__header";
    this.root.append(header);

    const brand = this.ownerDocument!.createElement("div");
    brand.className = "jra-popup__brand";
    const brandIcon = this.ownerDocument!.createElement("span");
    brandIcon.className = "jra-popup__brand-icon";
    setIcon(brandIcon, "languages");
    const brandText = this.ownerDocument!.createElement("span");
    brandText.textContent = "日语阅读助手";
    brand.append(brandIcon, brandText);
    header.append(brand);

    const controls = this.ownerDocument!.createElement("div");
    controls.className = "jra-popup__window-controls";
    header.append(controls);

    this.pinButton = this.makeIconButton(
      "pin",
      this.pinned ? "取消固定" : "固定弹窗",
      () => this.togglePinned(),
    );
    this.pinButton.setAttribute("aria-pressed", String(this.pinned));
    controls.append(this.pinButton);
    controls.append(
      this.makeIconButton("x", "关闭", () => {
        this.close();
      }),
    );

    if (this.composerOptions) {
      this.content = this.ownerDocument!.createElement("div");
      this.content.className = "jra-popup__content";
      this.root.append(this.content);
      this.attachDragging(header);
      return;
    }

    const modeBar = this.ownerDocument!.createElement("div");
    modeBar.className = "jra-popup__mode-bar";
    modeBar.setAttribute("role", "tablist");
    this.root.append(modeBar);
    this.modeButtons.clear();
    modeBar.append(
      this.makeModeButton("word", "词汇"),
      this.makeModeButton("sentence", "语法解析"),
    );

    const source = this.ownerDocument!.createElement("div");
    source.className = "jra-popup__source";
    const sourceLabel = this.ownerDocument!.createElement("span");
    sourceLabel.className = "jra-popup__eyebrow";
    sourceLabel.textContent = "原文";
    this.sourceText = this.ownerDocument!.createElement("div");
    this.sourceText.className = "jra-popup__source-text";
    this.sourceText.textContent = this.context.text;
    source.append(sourceLabel, this.sourceText);
    this.root.append(source);

    this.content = this.ownerDocument!.createElement("div");
    this.content.className = "jra-popup__content";
    this.root.append(this.content);

    this.attachDragging(header);
    this.updateModeButtons();
  }

  private renderComposer(): void {
    if (!this.content || !this.composerOptions) {
      return;
    }
    this.content.replaceChildren();
    const hint = this.ownerDocument!.createElement("p");
    hint.className = "jra-popup__assistant-hint";
    hint.textContent = "粘贴或输入日文，点击解析后将同时生成词汇与语法内容。";
    this.content.append(hint);

    const textArea = this.ownerDocument!.createElement("textarea");
    textArea.className = "jra-popup__assistant-input";
    textArea.placeholder = "在这里输入日文句子…";
    textArea.value = this.composerOptions.initialText;
    textArea.setAttribute("aria-label", "输入要解析的日文");
    this.content.append(textArea);

    const ocrState = this.ownerDocument!.createElement("div");
    ocrState.className = "jra-popup__ocr-state";
    const lamp = this.ownerDocument!.createElement("span");
    lamp.className = "jra-popup__ocr-lamp";
    lamp.classList.toggle("is-online", this.composerOptions.ocrOnline);
    lamp.classList.toggle("is-offline", !this.composerOptions.ocrOnline);
    lamp.setAttribute("aria-hidden", "true");
    const ocrText = this.ownerDocument!.createElement("span");
    ocrText.textContent = this.composerOptions.ocrMessage;
    const restart = this.ownerDocument!.createElement("button");
    restart.type = "button";
    restart.className = "jra-popup__ocr-restart";
    restart.textContent = this.composerOptions.ocrOnline ? "重启 OCR" : "启动 / 重试 OCR";
    restart.addEventListener("click", () => this.composerOptions?.onRestartOcr());
    ocrState.append(lamp, ocrText, restart);
    this.content.append(ocrState);

    const actions = this.ownerDocument!.createElement("div");
    actions.className = "jra-popup__assistant-actions";
    const analyze = this.ownerDocument!.createElement("button");
    analyze.type = "button";
    analyze.className = "mod-cta";
    analyze.textContent = "解析输入";
    analyze.addEventListener("click", () => {
      const text = textArea.value.trim();
      if (!text) {
        textArea.focus();
        return;
      }
      this.composerOptions?.onAnalyze(text);
    });
    actions.append(analyze);
    this.content.append(actions);
    window.setTimeout(() => textArea.focus(), 0);
  }

  private makeModeButton(mode: AnalysisMode, text: string): HTMLButtonElement {
    const button = this.ownerDocument!.createElement("button");
    button.type = "button";
    button.className = "jra-popup__mode-button";
    button.textContent = text;
    button.setAttribute("role", "tab");
    button.addEventListener("click", () => {
      if (this.mode === mode && this.state !== "error") {
        return;
      }
      this.mode = mode;
      this.updateModeButtons();
      if (this.currentResult?.kind === "sentence") {
        this.renderResult(this.currentResult);
        return;
      }
      this.handlers.onModeChange(mode);
    });
    this.modeButtons.set(mode, button);
    return button;
  }

  private updateModeButtons(): void {
    for (const [mode, button] of this.modeButtons) {
      const active = mode === this.mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    }
  }

  private renderLoading(): void {
    if (!this.content) {
      return;
    }
    this.content.replaceChildren();
    const loading = this.ownerDocument!.createElement("div");
    loading.className = "jra-popup__loading";
    const spinner = this.ownerDocument!.createElement("span");
    spinner.className = "jra-popup__spinner";
    spinner.setAttribute("aria-hidden", "true");
    const text = this.ownerDocument!.createElement("span");
    text.textContent =
      this.mode === "word" ? "正在查词…" : "正在翻译、整理词汇与语法…";
    loading.append(spinner, text);
    this.content.append(loading);

    const skeleton = this.ownerDocument!.createElement("div");
    skeleton.className = "jra-popup__skeleton";
    for (let index = 0; index < 3; index += 1) {
      skeleton.append(this.ownerDocument!.createElement("span"));
    }
    this.content.append(skeleton);
  }

  private renderResult(result: AnalysisResult): void {
    if (!this.content) {
      return;
    }
    this.content.replaceChildren();
    this.renderSource(result);

    const translation = this.makeSection("译文", "jra-popup__translation");
    translation.body.textContent = result.translation;
    this.content.append(translation.section);

    if (result.kind === "word") {
      const metaValues = [result.reading, result.partOfSpeech].filter(Boolean);
      if (metaValues.length > 0) {
        const meta = this.ownerDocument!.createElement("div");
        meta.className = "jra-popup__word-meta";
        for (const value of metaValues) {
          const chip = this.ownerDocument!.createElement("span");
          chip.textContent = value;
          meta.append(chip);
        }
        this.content.append(meta);
      }
      if (result.note) {
        const note = this.makeSection("用法", "jra-popup__plain-text");
        note.body.textContent = result.note;
        this.content.append(note.section);
      }
    } else if (this.mode === "word") {
      this.renderSentenceVocabulary(result);
    } else {
      this.renderSentenceGrammar(result);
    }

    const footer = this.ownerDocument!.createElement("div");
    footer.className = "jra-popup__footer";
    const copyButton = this.ownerDocument!.createElement("button");
    copyButton.type = "button";
    copyButton.className = "jra-popup__copy-button";
    const copyIcon = this.ownerDocument!.createElement("span");
    setIcon(copyIcon, "copy");
    const copyText = this.ownerDocument!.createElement("span");
    copyText.textContent = "复制译文";
    copyButton.append(copyIcon, copyText);
    copyButton.addEventListener("click", () => {
      void this.copyTranslation(result.translation, copyButton, copyText);
    });
    footer.append(copyButton);
    this.content.append(footer);
  }

  private renderSentenceVocabulary(result: SentenceAnalysisResult): void {
    if (!this.content) {
      return;
    }
    const section = this.ownerDocument!.createElement("section");
    section.className = "jra-popup__section";
    const label = this.ownerDocument!.createElement("div");
    label.className = "jra-popup__eyebrow";
    label.textContent = "可背诵词汇";
    section.append(label);

    if (result.vocabulary.length === 0) {
      const empty = this.ownerDocument!.createElement("div");
      empty.className = "jra-popup__empty";
      empty.textContent = "这句话里没有需要单独记忆的词汇。";
      section.append(empty);
      this.content.append(section);
      return;
    }

    const list = this.ownerDocument!.createElement("div");
    list.className = "jra-popup__vocabulary";
    for (const item of result.vocabulary) {
      const card = this.ownerDocument!.createElement("article");
      card.className = "jra-popup__vocab-card";

      const heading = this.ownerDocument!.createElement("div");
      heading.className = "jra-popup__vocab-heading";
      const surface = this.ownerDocument!.createElement("strong");
      surface.className = "jra-popup__vocab-surface";
      surface.textContent = item.surface;
      heading.append(surface);
      if (item.reading) {
        const reading = this.ownerDocument!.createElement("span");
        reading.className = "jra-popup__vocab-reading";
        reading.textContent = item.reading;
        heading.append(reading);
      }
      card.append(heading);

      const metaValues = [
        item.baseForm && item.baseForm !== item.surface
          ? `原形 ${item.baseForm}`
          : "",
        item.partOfSpeech,
      ].filter(Boolean);
      if (metaValues.length > 0) {
        const meta = this.ownerDocument!.createElement("div");
        meta.className = "jra-popup__vocab-meta";
        for (const value of metaValues) {
          const chip = this.ownerDocument!.createElement("span");
          chip.textContent = value;
          meta.append(chip);
        }
        card.append(meta);
      }

      if (item.meaning) {
        const meaning = this.ownerDocument!.createElement("div");
        meaning.className = "jra-popup__vocab-meaning";
        meaning.textContent = item.meaning;
        card.append(meaning);
      }
      if (item.contextualMeaning) {
        const contextual = this.ownerDocument!.createElement("div");
        contextual.className = "jra-popup__vocab-context";
        const contextLabel = this.ownerDocument!.createElement("span");
        contextLabel.textContent = "句中";
        const contextMeaning = this.ownerDocument!.createElement("span");
        contextMeaning.textContent = item.contextualMeaning;
        contextual.append(contextLabel, contextMeaning);
        card.append(contextual);
      }
      list.append(card);
    }
    section.append(list);
    this.content.append(section);
  }

  private renderSentenceGrammar(result: SentenceAnalysisResult): void {
    if (!this.content) {
      return;
    }
    if (result.structure) {
      const structure = this.makeSection("句子主干", "jra-popup__plain-text");
      structure.body.textContent = result.structure;
      this.content.append(structure.section);
    }

    const pointsSection = this.ownerDocument!.createElement("section");
    pointsSection.className = "jra-popup__section";
    const label = this.ownerDocument!.createElement("div");
    label.className = "jra-popup__eyebrow";
    label.textContent = "语法与用法";
    pointsSection.append(label);

    if (result.points.length === 0) {
      const empty = this.ownerDocument!.createElement("div");
      empty.className = "jra-popup__empty";
      empty.textContent = "这句话里没有需要特别说明的语法。";
      pointsSection.append(empty);
      this.content.append(pointsSection);
      return;
    }

    const list = this.ownerDocument!.createElement("div");
    list.className = "jra-popup__points";
    result.points.forEach((point, index) => {
      const colorIndex = index % 6;
      const row = this.ownerDocument!.createElement("article");
      row.className = `jra-popup__point jra-grammar-color-${colorIndex}`;
      const heading = this.ownerDocument!.createElement("div");
      heading.className = "jra-popup__point-heading";
      const marker = this.ownerDocument!.createElement("span");
      marker.className = "jra-popup__grammar-marker";
      marker.setAttribute("aria-hidden", "true");
      const form = this.ownerDocument!.createElement("strong");
      form.className = "jra-popup__point-form";
      form.textContent = point.form;
      heading.append(marker, form);
      if (point.source && point.source !== point.form) {
        const source = this.ownerDocument!.createElement("span");
        source.className = "jra-popup__point-source";
        source.textContent = point.source;
        heading.append(source);
      }
      row.append(heading);

      const meaning = this.ownerDocument!.createElement("div");
      meaning.className = "jra-popup__point-meaning";
      meaning.textContent = point.meaning;
      row.append(meaning);
      if (point.usage) {
        const usage = this.ownerDocument!.createElement("div");
        usage.className = "jra-popup__point-usage";
        usage.textContent = point.usage;
        row.append(usage);
      }
      list.append(row);
    });
    pointsSection.append(list);
    this.content.append(pointsSection);
  }

  private renderSource(result: AnalysisResult): void {
    if (!this.sourceText || !this.context) {
      return;
    }
    this.sourceText.replaceChildren();
    if (
      result.kind !== "sentence" ||
      this.mode !== "sentence" ||
      result.points.length === 0
    ) {
      this.sourceText.textContent = this.context.text;
      return;
    }
    this.appendAnnotatedSource(this.context.text, result.points);
  }

  private appendAnnotatedSource(text: string, points: GrammarPoint[]): void {
    if (!this.sourceText) {
      return;
    }
    const ranges: Array<{ start: number; end: number; index: number }> = [];
    points.forEach((point, index) => {
      if (!point.source) {
        return;
      }
      const start = text.indexOf(point.source);
      if (start < 0) {
        return;
      }
      const end = start + point.source.length;
      if (ranges.some((range) => start < range.end && end > range.start)) {
        return;
      }
      ranges.push({ start, end, index });
    });
    ranges.sort((left, right) => left.start - right.start);

    let cursor = 0;
    for (const range of ranges) {
      if (range.start > cursor) {
        this.sourceText.append(
          this.ownerDocument!.createTextNode(text.slice(cursor, range.start)),
        );
      }
      const mark = this.ownerDocument!.createElement("span");
      mark.className =
        `jra-popup__grammar-mark jra-grammar-color-${range.index % 6}`;
      mark.textContent = text.slice(range.start, range.end);
      mark.title = points[range.index]?.form ?? "";
      this.sourceText.append(mark);
      cursor = range.end;
    }
    if (cursor < text.length) {
      this.sourceText.append(
        this.ownerDocument!.createTextNode(text.slice(cursor)),
      );
    }
  }

  private renderError(message: string): void {
    if (!this.content) {
      return;
    }
    this.content.replaceChildren();
    const error = this.ownerDocument!.createElement("div");
    error.className = "jra-popup__error";
    const icon = this.ownerDocument!.createElement("span");
    setIcon(icon, "circle-alert");
    const text = this.ownerDocument!.createElement("div");
    text.textContent = message;
    error.append(icon, text);
    this.content.append(error);

    const retry = this.ownerDocument!.createElement("button");
    retry.type = "button";
    retry.className = "jra-popup__retry-button";
    retry.textContent = "重试";
    retry.addEventListener("click", () => this.handlers.onRetry());
    this.content.append(retry);
  }

  private makeSection(
    labelText: string,
    bodyClass: string,
  ): { section: HTMLElement; body: HTMLDivElement } {
    const section = this.ownerDocument!.createElement("section");
    section.className = "jra-popup__section";
    const label = this.ownerDocument!.createElement("div");
    label.className = "jra-popup__eyebrow";
    label.textContent = labelText;
    const body = this.ownerDocument!.createElement("div");
    body.className = bodyClass;
    section.append(label, body);
    return { section, body };
  }

  private makeIconButton(
    iconName: string,
    label: string,
    callback: () => void,
  ): HTMLButtonElement {
    const button = this.ownerDocument!.createElement("button");
    button.type = "button";
    button.className = "jra-popup__icon-button";
    button.setAttribute("aria-label", label);
    button.title = label;
    setIcon(button, iconName);
    button.addEventListener("click", callback);
    return button;
  }

  private togglePinned(): void {
    this.pinned = !this.pinned;
    this.root?.classList.toggle("is-pinned", this.pinned);
    if (this.pinButton) {
      this.pinButton.setAttribute("aria-pressed", String(this.pinned));
      this.pinButton.title = this.pinned ? "取消固定" : "固定弹窗";
      this.pinButton.setAttribute(
        "aria-label",
        this.pinned ? "取消固定" : "固定弹窗",
      );
    }
  }

  private async copyTranslation(
    translation: string,
    button: HTMLButtonElement,
    label: HTMLSpanElement,
  ): Promise<void> {
    try {
      await this.ownerDocument?.defaultView?.navigator.clipboard.writeText(translation);
      button.classList.add("is-success");
      label.textContent = "已复制";
      this.ownerDocument?.defaultView?.setTimeout(() => {
        if (button.isConnected) {
          button.classList.remove("is-success");
          label.textContent = "复制译文";
        }
      }, 1200);
    } catch {
      label.textContent = "复制失败";
    }
  }

  private position(anchor: RectLike): void {
    if (!this.root || !this.ownerDocument || this.manuallyPositioned) {
      return;
    }
    const view = this.ownerDocument.defaultView;
    if (!view) {
      return;
    }

    this.root.style.visibility = "hidden";
    this.root.style.display = "flex";
    const margin = 12;
    const gap = 10;
    const width = this.root.offsetWidth;
    const height = this.root.offsetHeight;

    let left = anchor.left + anchor.width / 2 - width / 2;
    left = Math.max(margin, Math.min(left, view.innerWidth - width - margin));

    let top = anchor.bottom + gap;
    if (top + height > view.innerHeight - margin) {
      top = anchor.top - height - gap;
    }
    top = Math.max(margin, Math.min(top, view.innerHeight - height - margin));

    this.root.style.left = `${Math.round(left)}px`;
    this.root.style.top = `${Math.round(top)}px`;
    this.root.style.visibility = "";
  }

  private attachDragging(header: HTMLElement): void {
    if (Platform.isMobile) {
      return;
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (
        this.dragCleanup ||
        event.button !== 0 ||
        typeof (event.target as Element | null)?.closest !== "function" ||
        (event.target as Element).closest("button")
      ) {
        return;
      }
      if (!this.root || !this.ownerDocument?.defaultView) {
        return;
      }
      const view = this.ownerDocument.defaultView;
      const startRect = this.root.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const activePointerId = event.pointerId;
      this.manuallyPositioned = true;
      header.setPointerCapture(activePointerId);

      const onPointerMove = (moveEvent: PointerEvent): void => {
        if (!this.root || moveEvent.pointerId !== activePointerId) {
          return;
        }
        const margin = 8;
        const left = Math.max(
          margin,
          Math.min(
            startRect.left + moveEvent.clientX - startX,
            view.innerWidth - this.root.offsetWidth - margin,
          ),
        );
        const top = Math.max(
          margin,
          Math.min(
            startRect.top + moveEvent.clientY - startY,
            view.innerHeight - this.root.offsetHeight - margin,
          ),
        );
        this.root.style.left = `${Math.round(left)}px`;
        this.root.style.top = `${Math.round(top)}px`;
      };
      const finish = (finishEvent?: PointerEvent): void => {
        if (finishEvent && finishEvent.pointerId !== activePointerId) {
          return;
        }
        header.removeEventListener("pointermove", onPointerMove);
        header.removeEventListener("pointerup", finish);
        header.removeEventListener("pointercancel", finish);
        header.removeEventListener("lostpointercapture", finish);
        if (header.hasPointerCapture(activePointerId)) {
          header.releasePointerCapture(activePointerId);
        }
        if (this.dragCleanup === finish) {
          this.dragCleanup = null;
        }
      };
      header.addEventListener("pointermove", onPointerMove);
      header.addEventListener("pointerup", finish);
      header.addEventListener("pointercancel", finish);
      header.addEventListener("lostpointercapture", finish);
      this.dragCleanup = finish;
    };

    header.addEventListener("pointerdown", onPointerDown);
  }
}
