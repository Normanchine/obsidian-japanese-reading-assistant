import { App, Modal } from "obsidian";
import type { AnalysisMode, RectLike } from "./types";

export interface PdfOcrCrop {
  imageBase64: string;
  anchor: RectLike;
  document: Document;
}

interface CanvasCandidate {
  canvas: HTMLCanvasElement;
  rect: DOMRect;
  visibleArea: number;
}

function toRectLike(rect: DOMRect): RectLike {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function visibleArea(rect: DOMRect, viewportWidth: number, viewportHeight: number): number {
  const width = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
  const height = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
  return width * height;
}

export function findPdfPageCanvas(containerEl: HTMLElement): HTMLCanvasElement | null {
  const document = containerEl.ownerDocument;
  const viewportWidth = document.defaultView?.innerWidth ?? 0;
  const viewportHeight = document.defaultView?.innerHeight ?? 0;
  const candidates: CanvasCandidate[] = [];

  for (const canvas of Array.from(containerEl.querySelectorAll("canvas"))) {
    const rect = canvas.getBoundingClientRect();
    const area = visibleArea(rect, viewportWidth, viewportHeight);
    if (canvas.width > 0 && canvas.height > 0 && area > 0) {
      candidates.push({ canvas, rect, visibleArea: area });
    }
  }

  candidates.sort((left, right) => right.visibleArea - left.visibleArea);
  return candidates[0]?.canvas ?? null;
}

function cropCanvas(
  source: HTMLCanvasElement,
  rect: DOMRect,
  left: number,
  top: number,
  right: number,
  bottom: number,
): PdfOcrCrop {
  const scaleX = source.width / rect.width;
  const scaleY = source.height / rect.height;
  const sourceLeft = Math.max(0, Math.floor((left - rect.left) * scaleX));
  const sourceTop = Math.max(0, Math.floor((top - rect.top) * scaleY));
  const sourceRight = Math.min(source.width, Math.ceil((right - rect.left) * scaleX));
  const sourceBottom = Math.min(source.height, Math.ceil((bottom - rect.top) * scaleY));
  const width = sourceRight - sourceLeft;
  const height = sourceBottom - sourceTop;

  if (width < 4 || height < 4) {
    throw new Error("框选区域太小，请框住完整的词语或句子。");
  }

  const output = source.ownerDocument.createElement("canvas");
  output.width = width;
  output.height = height;
  const context = output.getContext("2d");
  if (!context) {
    throw new Error("无法创建 OCR 图像。");
  }
  context.drawImage(source, sourceLeft, sourceTop, width, height, 0, 0, width, height);

  const imageBase64 = output.toDataURL("image/png").replace(/^data:image\/png;base64,/u, "");
  return {
    imageBase64,
    anchor: toRectLike(new DOMRect(left, top, right - left, bottom - top)),
    document: source.ownerDocument,
  };
}

export function capturePdfRegion(
  containerEl: HTMLElement,
  initialPointerEvent?: PointerEvent,
): Promise<PdfOcrCrop> {
  const source = findPdfPageCanvas(containerEl);
  if (!source) {
    return Promise.reject(new Error("未找到可截图的 PDF 页面，请等待页面加载完成后重试。"));
  }

  const document = source.ownerDocument;
  const window = document.defaultView;
  if (!window) {
    return Promise.reject(new Error("无法访问当前 PDF 窗口。"));
  }
  const rect = source.getBoundingClientRect();

  return new Promise((resolve, reject) => {
    const overlay = document.createElement("div");
    const selection = document.createElement("div");
    const hint = document.createElement("div");
    overlay.className = "jra-pdf-ocr-crop-overlay";
    Object.assign(overlay.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    selection.className = "jra-pdf-ocr-crop-selection";
    hint.className = "jra-pdf-ocr-crop-hint";
    hint.textContent = "拖动框选日文；按 Esc 取消";
    overlay.append(selection, hint);
    document.body.appendChild(overlay);

    let startX = 0;
    let startY = 0;
    let activePointerId: number | null = null;
    let completed = false;

    const cleanUp = (): void => {
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
      overlay.remove();
    };

    const cancel = (message?: string): void => {
      if (completed) {
        return;
      }
      completed = true;
      cleanUp();
      reject(new Error(message ?? "已取消 PDF 框选。"));
    };

    const renderSelection = (x: number, y: number): void => {
      const left = Math.min(startX, x);
      const top = Math.min(startY, y);
      selection.style.left = `${left - rect.left}px`;
      selection.style.top = `${top - rect.top}px`;
      selection.style.width = `${Math.abs(x - startX)}px`;
      selection.style.height = `${Math.abs(y - startY)}px`;
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0 || activePointerId !== null) {
        return;
      }
      activePointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      try {
        overlay.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is not available in every embedded PDF surface.
      }
      renderSelection(startX, startY);
      event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (event.pointerId !== activePointerId) {
        return;
      }
      const x = Math.max(rect.left, Math.min(event.clientX, rect.right));
      const y = Math.max(rect.top, Math.min(event.clientY, rect.bottom));
      renderSelection(x, y);
      event.preventDefault();
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (event.pointerId !== activePointerId) {
        return;
      }
      activePointerId = null;
      const endX = Math.max(rect.left, Math.min(event.clientX, rect.right));
      const endY = Math.max(rect.top, Math.min(event.clientY, rect.bottom));
      try {
        const crop = cropCanvas(source, rect, startX, startY, endX, endY);
        completed = true;
        cleanUp();
        resolve(crop);
      } catch (error) {
        completed = true;
        cleanUp();
        reject(error);
      }
      event.preventDefault();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    };

    const onViewportChange = (): void => cancel("PDF 视图已变化，请重新框选。");

    overlay.addEventListener("pointerdown", onPointerDown);
    overlay.addEventListener("pointermove", onPointerMove);
    overlay.addEventListener("pointerup", onPointerUp);
    overlay.addEventListener("pointercancel", () => cancel());
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    if (initialPointerEvent) {
      onPointerDown(initialPointerEvent);
    }
  });
}

export class OcrReviewModal extends Modal {
  constructor(
    app: App,
    private readonly recognizedText: string,
    private readonly onAnalyze: (text: string, mode: AnalysisMode) => void,
    private readonly defaultMode: AnalysisMode,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("jra-ocr-review-modal");
    this.contentEl.createEl("h2", { text: "确认 OCR 文本" });
    this.contentEl.createEl("p", {
      text: "OCR 只提取正文。请确认或修正后，再交给日语解析模型。",
      cls: "setting-item-description",
    });
    const textArea = this.contentEl.createEl("textarea", {
      cls: "jra-ocr-review-modal__text",
    });
    textArea.value = this.recognizedText;
    textArea.setAttr("aria-label", "OCR 识别结果");

    const actions = this.contentEl.createDiv({ cls: "jra-ocr-review-modal__actions" });
    const addAction = (label: string, mode: AnalysisMode, primary = false): void => {
      const button = actions.createEl("button", { text: label });
      if (primary) {
        button.addClass("mod-cta");
      }
      button.addEventListener("click", () => {
        const text = textArea.value.trim();
        if (!text) {
          textArea.focus();
          return;
        }
        this.onAnalyze(text, mode);
        this.close();
      });
    };
    addAction("作为词语翻译", "word", this.defaultMode === "word");
    addAction("作为句子解析", "sentence", this.defaultMode === "sentence");
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    window.setTimeout(() => {
      textArea.focus();
      textArea.select();
    }, 0);
  }

  onClose(): void {
    this.contentEl.empty();
    this.modalEl.removeClass("jra-ocr-review-modal");
  }
}
