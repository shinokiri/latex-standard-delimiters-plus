import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';

/** Available inline space after the host's actual list/quote/indent prefix.
 * Measure rendered prefixes rather than guessing their width from TeX offsets:
 * themes, list markers, tabs and proportional fonts all change that width.
 */
export function containerDisplayWidth(element: HTMLElement): number | null {
  const line = element.closest<HTMLElement>('.cm-line');
  const ownerWindow = element.ownerDocument.defaultView;
  if (!line || !ownerWindow || !element.isConnected) return null;
  const rect = line.getBoundingClientRect();
  const style = ownerWindow.getComputedStyle(line);
  const pixels = (value: string): number => Number.parseFloat(value) || 0;
  const left = rect.left + pixels(style.borderLeftWidth) + pixels(style.paddingLeft);
  const right = rect.right - pixels(style.borderRightWidth) - pixels(style.paddingRight);
  if (right <= left) return null; // Hidden panes cannot provide layout yet.
  const prefix = element.ownerDocument.createRange();
  prefix.selectNodeContents(line);
  prefix.setEndBefore(element);
  const rectangles = Array.from(prefix.getClientRects()).filter(box => box.width > 0 && box.height > 0);
  const last = rectangles.at(-1);
  const width = style.direction === 'rtl'
    ? Math.min(right, last?.left ?? right) - left
    : right - Math.max(left, last?.right ?? left);
  return Math.max(1, Math.floor(width * 100) / 100);
}

export const displayLayout = ViewPlugin.fromClass(class {
  constructor(private readonly view: EditorView) { this.measure(); }
  update(update: ViewUpdate): void {
    if (update.transactions.length || update.geometryChanged || update.viewportChanged) this.measure();
  }
  private measure(): void {
    this.view.requestMeasure({
      key: this,
      read: view => Array.from(view.dom.querySelectorAll<HTMLElement>('.lsd-math-container-display')).map(element => ({
        element, width: containerDisplayWidth(element)
      })),
      write: measurements => {
        let changed = false;
        for (const {element, width} of measurements) {
          if (width === null || !element.isConnected) continue;
          const previous = Number.parseFloat(element.style.width);
          if (!Number.isFinite(previous) || Math.abs(previous - width) > 0.5) {
            element.style.width = `${width}px`;
            changed = true;
          }
        }
        if (changed) this.view.requestMeasure();
      }
    });
  }
});
