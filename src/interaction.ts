/** Reveal after a completed click, once the browser has finished the gesture
 * and CodeMirror has read pending DOM mutations. Keep pointerup's target alive
 * through the subsequent synthetic mouse/click and selection events.
 */
import type { MathClick } from "./math-source-map";

export function registerMathActivation(element: HTMLElement, composing: () => boolean, reveal: (click: MathClick) => void): () => void {
  const timerWindow = element.ownerDocument.defaultView ?? window;
  let timer: number | undefined;
  let suppressMouseUntil = -Infinity;
  let tapped = false;
  let disposed = false;
  let touch: { id: number; x: number; y: number; time: number; moved: boolean } | null = null;
  element.addEventListener("mousedown", event => {
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    if ((event.target as Element | null)?.closest("a, button, input, textarea, select, .interactive-child")) return;
    event.preventDefault();
    event.stopPropagation();
  });
  element.addEventListener("click", event => {
    if (disposed || event.button !== 0 || event.detail > 1 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || composing()) return;
    const target = event.target as Element | null;
    if (!target || target.closest("a, button, input, textarea, select, .interactive-child")) return;
    if (event.timeStamp <= suppressMouseUntil && !tapped) return;
    tapped = false;
    const selection = element.ownerDocument.getSelection();
    if (selection && !selection.isCollapsed && (element.contains(selection.anchorNode) || element.contains(selection.focusNode))) return;
    event.preventDefault();
    event.stopPropagation();
    const click = {target, x: event.clientX, y: event.clientY};
    timerWindow.clearTimeout(timer);
    timer = timerWindow.setTimeout(() => {
      timer = undefined;
      if (!disposed && element.isConnected && !composing()) reveal(click);
    }, 0);
  });
  element.addEventListener("pointerdown", event => {
    timerWindow.clearTimeout(timer);
    tapped = false;
    if (event.pointerType === "mouse") { suppressMouseUntil = -Infinity; return; }
    if (event.pointerType !== "touch") return;
    suppressMouseUntil = event.timeStamp + 800;
    if (!event.isPrimary) { touch = null; return; }
    touch = { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp, moved: false };
  });
  element.addEventListener("pointermove", event => {
    if (touch?.id === event.pointerId && Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 8) touch.moved = true;
  });
  element.addEventListener("pointercancel", event => {
    suppressMouseUntil = event.timeStamp + 800;
    tapped = false;
    touch = null;
  });
  element.addEventListener("pointerup", event => {
    if (event.pointerType !== "touch") return;
    suppressMouseUntil = event.timeStamp + 800;
    const start = touch;
    touch = null;
    if (!start || composing() || start.moved || start.id !== event.pointerId || event.timeStamp - start.time > 500 ||
      Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) return;
    tapped = true;
  });
  return () => { disposed = true; timerWindow.clearTimeout(timer); };
}
