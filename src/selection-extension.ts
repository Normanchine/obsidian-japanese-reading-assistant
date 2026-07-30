import {
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import {
  EditorSelection,
  Prec,
  type Extension,
} from "@codemirror/state";
import type { RectLike, SelectionContext } from "./types";

export type EditorSelectionCallback = (
  context: SelectionContext | null,
) => void;

function rectFromCoordinates(
  coordinates: { left: number; right: number; top: number; bottom: number },
): RectLike {
  return {
    left: coordinates.left,
    right: coordinates.right,
    top: coordinates.top,
    bottom: coordinates.bottom,
    width: Math.max(0, coordinates.right - coordinates.left),
    height: Math.max(0, coordinates.bottom - coordinates.top),
  };
}

function editorFallbackRect(view: EditorView): RectLike {
  const rect = view.dom.getBoundingClientRect();
  const left = Math.min(
    rect.right - 16,
    Math.max(rect.left + 16, rect.left + rect.width / 2),
  );
  const top = Math.min(
    rect.bottom - 16,
    Math.max(rect.top + 16, rect.top + rect.height / 3),
  );
  return {
    left,
    right: left,
    top,
    bottom: top,
    width: 0,
    height: 0,
  };
}

export function createEditorSelectionExtension(
  callback: EditorSelectionCallback,
  usePlainAltSelection: () => boolean,
): Extension {
  const plainAltSelection = Prec.highest(
    EditorView.mouseSelectionStyle.of((view, event) => {
      if (
        !usePlainAltSelection() ||
        !event.altKey ||
        event.button !== 0
      ) {
        return null;
      }

      const startPosition = view.posAtCoords({
        x: event.clientX,
        y: event.clientY,
      });
      if (startPosition === null) {
        return null;
      }
      const initialSelection = view.state.selection.main;

      return {
        get(currentEvent, extend) {
          const currentPosition =
            view.posAtCoords({
              x: currentEvent.clientX,
              y: currentEvent.clientY,
            }) ?? startPosition;
          const anchor = extend ? initialSelection.anchor : startPosition;
          return EditorSelection.single(anchor, currentPosition);
        },
        update() {
          return false;
        },
      };
    }),
  );

  const selectionObserver = ViewPlugin.fromClass(
    class {
      private readonly view: EditorView;

      constructor(view: EditorView) {
        this.view = view;
      }

      update(update: ViewUpdate): void {
        if (!update.selectionSet) {
          return;
        }

        const selection = update.state.selection.main;
        if (selection.empty) {
          callback(null);
          return;
        }

        const text = update.state.sliceDoc(selection.from, selection.to);
        const contextStart = Math.max(0, selection.from - 80);
        const contextEnd = Math.min(update.state.doc.length, selection.to + 80);
        const coordinates = this.view.coordsAtPos(selection.head, 1);
        callback({
          text,
          anchor: coordinates
            ? rectFromCoordinates(coordinates)
            : editorFallbackRect(this.view),
          document: this.view.dom.ownerDocument,
          surroundingText: update.state.sliceDoc(contextStart, contextEnd),
        });
      }
    },
  );

  return [plainAltSelection, selectionObserver];
}
