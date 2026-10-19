import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { containerDisplayWidth } from '../src/display-layout';

// jsdom does not lay out text. Feed measured geometry explicitly to test the
// sizing policy without claiming a browser/Obsidian visual test.
function fixture(direction = 'ltr') {
  const dom = new JSDOM('<!doctype html><div class="cm-line"><span class="prefix">1. </span><span class="lsd-math-container-display">MATH</span></div>');
  const line = dom.window.document.querySelector<HTMLElement>('.cm-line')!;
  const element = line.querySelector<HTMLElement>('.lsd-math-container-display')!;
  line.style.cssText = `direction:${direction}; padding:0 12px 0 20px; border:2px solid black`;
  let lineRight = 420, prefixLeft = 122, prefixRight = 154;
  const box = (left: number, right: number) => new dom.window.DOMRect(left, 0, right - left, 24);
  line.getBoundingClientRect = () => box(100, lineRight);
  Object.defineProperty(dom.window.Range.prototype, 'getClientRects', {value(this: Range) {
    assert.equal(this.startContainer, line);
    assert.equal(this.endContainer, line);
    assert.equal(this.endOffset, 1, 'only prefix geometry is measured, even before the formula fits its line');
    return [box(prefixLeft, prefixRight)];
  }});
  return {dom, line, element, resize: (right: number) => {lineRight = right;}, prefix: (left: number, right: number) => {prefixLeft = left; prefixRight = right;}};
}

test('container display fits the space after rendered prefixes and recalculates for narrow panes', () => {
  const f = fixture();
  try {
    assert.equal(containerDisplayWidth(f.element), 252);
    f.resize(300);
    assert.equal(containerDisplayWidth(f.element), 132);
    f.prefix(122, 176);
    assert.equal(containerDisplayWidth(f.element), 110, 'theme/font/marker width comes from actual prefix geometry');
    f.prefix(90, 110);
    assert.equal(containerDisplayWidth(f.element), 164, 'a hanging list marker does not expand the math past the content edge');
  } finally { f.dom.window.close(); }
});

test('container sizing handles RTL prefixes and detached/hidden editor panes', () => {
  const f = fixture('rtl');
  try {
    f.prefix(380, 406);
    assert.equal(containerDisplayWidth(f.element), 258);
    f.resize(100);
    assert.equal(containerDisplayWidth(f.element), null, 'wait for hidden pane layout');
    f.element.remove();
    assert.equal(containerDisplayWidth(f.element), null);
  } finally { f.dom.window.close(); }
});
