import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import MarkdownIt from 'markdown-it';
import type { EditorState, StateField, StateEffectType, Facet, Extension } from '@codemirror/state';
import type { DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import type { MathDelimiterMatch } from '../src/parser';
import type { MathPresentation } from '../src/presentation';

// Real plugin callback, DOM ranges and CodeMirror states; host MathJax records
// its exact TeX input. This suite does not claim real-device layout validation.
const rootPath = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localRequire = createRequire(import.meta.url);
// Use the same CM instance as the CommonJS plugin. Mixing Node's ESM and CJS
// entry points gives state fields independent numeric IDs and invalid fixtures.
const cmState = localRequire('@codemirror/state') as typeof import('@codemirror/state');
const source = readFileSync(resolve(rootPath, 'src/main.ts'), 'utf8');
const bundle = build({
  stdin: {
    contents: source + '\nexport {renderReadingView, findMathDelimiters, mathPresentation, buildLivePreviewDecorations, compositionState, setComposing, renderOptions, editingPreviewState, livePreviewExtension, vimSourceState, setVimSource, compositionEvents, displayLayout};',
    sourcefile: 'test-entry.ts', resolveDir: resolve(rootPath, 'src'), loader: 'ts',
  },
  bundle: true, packages: 'external', format: 'cjs', platform: 'browser', write: false,
});

class Component {
  onload(): void {}
  onunload(): void {}
  load(): void { this.onload(); }
  unload(): void { this.onunload(); }
}
class MarkdownRenderChild extends Component {
  constructor(readonly containerEl: HTMLElement) { super(); }
}
type Formula = { source: string; display: boolean };
type API = {
  renderReadingView(element: HTMLElement, context: unknown, plugin: object): Promise<void>;
  findMathDelimiters(text: string): MathDelimiterMatch[];
  mathPresentation(text: string, match: MathDelimiterMatch): MathPresentation;
  buildLivePreviewDecorations(state: EditorState): DecorationSet;
  compositionState: StateField<boolean>;
  setComposing: StateEffectType<boolean>;
  compositionEvents: Extension;
  displayLayout: Extension;
  editingPreviewState: StateField<unknown>;
  livePreviewExtension: StateField<DecorationSet>;
  vimSourceState: StateField<boolean>;
  setVimSource: StateEffectType<boolean>;
  renderOptions: Facet<{previews: boolean; enabled: boolean}, {previews: boolean; enabled: boolean}>;
};

async function fixture(breaks = false) {
  const dom = new JSDOM('<!doctype html><body></body>', {pretendToBeVisual: true});
  const {document} = dom.window;
  Object.defineProperty(dom.window.Node.prototype, 'instanceOf', {
    value(this: Node, ctor: typeof Node) { return this instanceof ctor; },
  });
  const md = new MarkdownIt({breaks});
  const calls: Formula[] = [];
  const livePreview = cmState.StateField.define({create: () => true, update: value => value});
  const host = {
    Component, MarkdownRenderChild, Plugin: class {}, PluginSettingTab: class {},
    Modal: class {}, Notice: class {}, Setting: class {}, MarkdownView: class {}, TFile: class {},
    editorLivePreviewField: livePreview,
    MarkdownRenderer: { render: async (_app: unknown, text: string, target: HTMLElement) => { target.innerHTML = md.render(text); } },
    renderMath: (text: string, display: boolean) => {
      calls.push({source: text, display});
      const result = document.createElement('span');
      result.className = 'math'; result.textContent = 'MATH';
      return result;
    },
    finishRenderMath: async () => {}, loadMathJax: async () => {},
  };
  const module = {exports: {}};
  vm.runInNewContext((await bundle).outputFiles[0].text, {
    module, exports: module.exports, document, window: dom.window, console, queueMicrotask,
    Node: dom.window.Node, Text: dom.window.Text, HTMLElement: dom.window.HTMLElement,
    require: (name: string) => {
      if (name === 'obsidian') return host;
      assert.ok(/^@codemirror\//.test(name), 'production must only import the host and CodeMirror');
      return localRequire(name);
    },
  });
  const api = module.exports as API;
  const children: Component[] = [];
  const plugin = {app: {}};
  function mount(text: string) {
    const root = document.createElement('div'); root.innerHTML = md.render(text);
    document.body.appendChild(root);
    return root as unknown as HTMLElement;
  }
  async function render(element: HTMLElement, text: string, lineStart = 0, lineEnd = text.split('\n').length - 1) {
    await api.renderReadingView(element, {
      sourcePath: 'fixture.md', docId: 'fixture.md',
      getSectionInfo: () => ({text, lineStart, lineEnd}),
      addChild: (child: Component) => { children.push(child); child.load(); },
    }, plugin);
  }
  function restore() { for (const child of children.splice(0)) child.unload(); }
  return {dom, md, api, calls, mount, render, restore, livePreview, close: () => { restore(); dom.window.close(); }};
}

function editorWidgets(f: Awaited<ReturnType<typeof fixture>>, state: EditorState) {
  const widgets: Array<{from: number; to: number; widget: WidgetType; element: HTMLElement; block: boolean}> = [];
  const view = {dom: f.dom.window.document.body, state, composing: false} as unknown as EditorView;
  const decorations = state.field(f.api.livePreviewExtension, false) ?? f.api.buildLivePreviewDecorations(state);
  decorations.between(0, state.doc.length, (from, to, decoration) => {
    const widget = decoration.spec.widget as WidgetType | undefined;
    if (widget) widgets.push({from, to, widget, element: widget.toDOM(view), block: !!decoration.spec.block});
  });
  return widgets;
}

test('Live Preview gives standalone container displays their own centered layout without replacing prefixes', async () => {
  const f = await fixture();
  try {
    for (const formula of [
      '   \\[\n   x+1\n   \\]',
      '1. Item\n\n   \\[\n   x+1\n   \\]',
      '> \\[\n> x+1\n> \\]',
      '- \\[x+1\\]',
      '   \\[x+1\\]   ',
    ]) {
      const text = 'Before\n\n' + formula + '\n\nAfter';
      const state = cmState.EditorState.create({doc: text, extensions: f.livePreview});
      const [rendered] = editorWidgets(f, state);
      assert.ok(rendered.element.classList.contains('lsd-math-container-display'), formula);
      assert.equal(rendered.block, false, 'keep CodeMirror line/container structure');
      assert.equal(rendered.from, text.indexOf('\\['), 'list and quote prefixes stay outside replacements');
      assert.equal(f.calls.at(-1)!.display, true);
      assert.equal(state.doc.toString(), text);
    }
    for (const formula of ['Inline \\(x+1\\).', 'Given \\[x+\n1\\], continue.']) {
      const text = 'Before\n\n' + formula;
      const state = cmState.EditorState.create({doc: text, extensions: f.livePreview});
      assert.equal(editorWidgets(f, state)[0].element.classList.contains('lsd-math-container-display'), false, 'do not stretch adjacent prose');
    }
  } finally { f.close(); }
});

test('editing preview survives word/line selections and taps on display indentation', async () => {
  const f = await fixture();
  try {
    const text = 'Before\n\n1. Item\n\n   \\[\n   x+1\n   \\]   \n\nAfter';
    const start = text.indexOf('\\['), end = text.indexOf('\\]') + 2, x = text.indexOf('x+1');
    let state = cmState.EditorState.create({doc: text, selection: {anchor: x}, extensions: [f.livePreview, f.api.editingPreviewState, f.api.livePreviewExtension]});
    const selections = [
      {anchor: x}, {anchor: x, head: x + 1}, {anchor: x - 3, head: x + 4},
      {anchor: start - 3}, {anchor: end + 2}, {anchor: end + 3, head: start - 3},
      {anchor: x + 1}, {anchor: x, head: x + 3},
    ];
    for (const selection of selections) {
      state = state.update({selection}).state;
      const widgets = editorWidgets(f, state);
      assert.equal(widgets.filter(w => w.element.classList.contains('lsd-editing-preview')).length, 1, JSON.stringify(selection));
      assert.ok(widgets.every(w => w.from === w.to), 'source text remains editable');
    }
    state = state.update({selection: {anchor: start - 3, head: end + 4}}).state;
    assert.equal(editorWidgets(f, state).filter(w => w.element.classList.contains('lsd-editing-preview')).length, 1, 'selecting the closing source line includes its newline');
    state = state.update({selection: {anchor: x, head: text.length}}).state;
    assert.equal(editorWidgets(f, state).filter(w => w.element.classList.contains('lsd-editing-preview')).length, 0, 'selection extends into surrounding prose');
    state = state.update({selection: {anchor: text.length}}).state;
    assert.equal(editorWidgets(f, state).filter(w => w.element.classList.contains('lsd-editing-preview')).length, 0, 'leaving the equation closes its editing preview');
    assert.equal(state.doc.toString(), text);
  } finally { f.close(); }
});

test('an inline word selection keeps its preview, while selecting multiple equations does not', async () => {
  const f = await fixture();
  try {
    const text = 'Before \\(alpha+1\\) and \\(beta+2\\).';
    const anchor = text.indexOf('alpha');
    let state = cmState.EditorState.create({doc: text, selection: {anchor, head: anchor + 5}, extensions: f.livePreview});
    assert.equal(editorWidgets(f, state).filter(w => w.element.classList.contains('lsd-editing-preview')).length, 1);
    state = state.update({selection: {anchor, head: text.indexOf('beta') + 4}}).state;
    assert.equal(editorWidgets(f, state).filter(w => w.element.classList.contains('lsd-editing-preview')).length, 0);
  } finally { f.close(); }
});

const repeatedList = String.raw`1. First \(A\), again \(A\), and literal (A).

   \[
   A\cap B=A
   \]

2. Second \(A\) and \(A\).

   \[
   A\subseteq B
   \]`;

for (const breaks of [false, true]) {
  test(`reading lists render repeated inline math and multiline displays; breaks=${breaks}`, async () => {
    const f = await fixture(breaks);
    try {
      const root = f.mount(repeatedList), before = root.innerHTML;
      const items = Array.from(root.querySelectorAll('ol > li')) as HTMLElement[];
      const spans = f.md.parse(repeatedList, {}).filter(t => t.type === 'list_item_open' && t.level === 1).map(t => t.map!);
      for (let i = 0; i < items.length; i++) await f.render(items[i], repeatedList, spans[i][0], spans[i][1] - 1);
      assert.equal(f.calls.filter(x => !x.display).length, 4);
      assert.equal(f.calls.filter(x => x.display).length, 2);
      assert.ok(root.textContent!.includes('literal (A)'), 'ordinary lookalikes remain text');
      const after = root.innerHTML;
      for (let i = 0; i < items.length; i++) await f.render(items[i], repeatedList, spans[i][0], spans[i][1] - 1);
      assert.equal(f.calls.length, 6, 'idempotent repeated callbacks');
      assert.equal(root.innerHTML, after);
      f.restore(); assert.equal(root.innerHTML, before, 'unload restores the list structure');
    } finally { f.close(); }
  });

  const actualPath = resolve(rootPath, '.local-fixtures/probability-list.md');
  test(`private probability note: 29 inline + 4 display, whole list and per item; breaks=${breaks}`, {skip: !existsSync(actualPath)}, async () => {
    const bytes = readFileSync(actualPath), text = bytes.toString('utf8');
    const f = await fixture(breaks);
    try {
      const root = f.mount(text), before = root.innerHTML;
      await f.render(root, text);
      assert.equal(f.calls.filter(x => !x.display).length, 29);
      assert.equal(f.calls.filter(x => x.display).length, 4);
      const expected = f.api.findMathDelimiters(text).map(match => ({source: f.api.mathPresentation(text, match).source, display: match.display}));
      assert.deepEqual(f.calls, JSON.parse(JSON.stringify(expected.reverse())));
      f.restore(); assert.equal(root.innerHTML, before);
      f.calls.length = 0;
      const spans = f.md.parse(text, {}).filter(t => t.type === 'list_item_open' && t.level === 1).map(t => t.map!);
      const items = Array.from(root.querySelectorAll('ol > li')) as HTMLElement[];
      for (let i = 0; i < items.length; i++) await f.render(items[i], text, spans[i][0], spans[i][1] - 1);
      assert.equal(f.calls.filter(x => !x.display).length, 29);
      assert.equal(f.calls.filter(x => x.display).length, 4);
      f.restore(); assert.equal(root.innerHTML, before);
      assert.deepEqual(readFileSync(actualPath), bytes);
    } finally { f.close(); }
  });
}

test('reading uses exact TeX through indentation, quotes, emphasis and mixed prose', async () => {
  const cases = [
    String.raw`   \[
   x+1
   \]`,
    String.raw`Given \[x+
1\], continue.`,
    String.raw`> \[
> \text{a  b}+x_1
> \]`,
    String.raw`12. Explanation

    \[
    x_1+x_2
    \]`,
    String.raw`Inline \(\{x\}+a_b+c_d\) and \(\{x\}+a_b+c_d\).`,
  ];
  const f = await fixture();
  try {
    for (const text of cases) {
      f.calls.length = 0;
      const root = f.mount(text), before = root.innerHTML;
      await f.render(root, text);
      const expected = f.api.findMathDelimiters(text).map(match => ({source: f.api.mathPresentation(text, match).source, display: match.display}));
      assert.deepEqual(f.calls, JSON.parse(JSON.stringify(expected.reverse())), text);
      f.restore(); assert.equal(root.innerHTML, before);
      root.remove();
    }
  } finally { f.close(); }
});

test('reading leaves inline code, fenced code, native dollars and literal brackets alone', async () => {
  const text = '`\\(code\\)`\n\n```tex\n\\[fence\\]\n```\n\n$\\(native\\)$\n\nLiteral (x), actual \\(x\\).';
  const f = await fixture();
  try {
    const root = f.mount(text), before = root.innerHTML;
    await f.render(root, text);
    assert.deepEqual(f.calls, [{source: 'x', display: false}]);
    assert.equal(root.querySelectorAll('.lsd-math').length, 1);
    assert.ok(root.querySelector('pre')!.textContent!.includes('\\[fence\\]'));
    f.restore(); assert.equal(root.innerHTML, before);
  } finally { f.close(); }
});

test('IME retains the last committed preview outside the editable source', async () => {
  const f = await fixture();
  try {
    const text = 'Before \\(x_1+2\\) after.';
    const sourceMode = cmState.EditorState.create({doc: text});
    assert.equal(f.api.buildLivePreviewDecorations(sourceMode).size, 0);
    let state = cmState.EditorState.create({doc: text, selection: {anchor: 10}, extensions: [f.livePreview, f.api.compositionState, f.api.editingPreviewState, f.api.livePreviewExtension]});
    const [before] = editorWidgets(f, state);
    assert.ok(before.element.classList.contains('lsd-editing-preview'));
    state = state.update({effects: f.api.setComposing.of(true)}).state;
    assert.equal(editorWidgets(f, state).length, 1, 'merely starting composition must not hide the preview');
    state = state.update({changes: {from: 10, insert: '2'}}).state;
    const [during] = editorWidgets(f, state);
    assert.equal(during.from, during.to, 'preview is outside the editable source');
    assert.ok(before.widget.eq(during.widget), 'CodeMirror can keep exactly the same preview DOM during composition');
    assert.equal(f.calls.at(-1)!.source, 'x_1+2', 'hold the previous rendering while IME owns the text');
    state = state.update({effects: f.api.setComposing.of(false)}).state;
    const [after] = editorWidgets(f, state);
    assert.ok(!before.widget.eq(after.widget));
    assert.equal(f.calls.at(-1)!.source, 'x2_1+2', 'committing composition updates the preview');
  } finally { f.close(); }
});

test('entering a formula after composition has already started creates its first preview', async () => {
  const f = await fixture();
  try {
    for (const formula of ['\\(x+1\\)', '   \\[\n   x+1\n   \\]']) {
      const text = 'Before\n\n' + formula + '\n\nAfter';
      let state = cmState.EditorState.create({doc: text, extensions: [f.livePreview, f.api.compositionState, f.api.editingPreviewState, f.api.livePreviewExtension]});
      state = state.update({effects: f.api.setComposing.of(true)}).state;
      assert.equal(state.field(f.api.editingPreviewState), null);
      const match = f.api.findMathDelimiters(text)[0];
      for (const anchor of [text.indexOf('x+1'), match.from + 2, match.from, match.to - 2, match.to, text.indexOf('x+1') + 1]) {
        state = state.update({selection: {anchor}}).state;
        const widgets = editorWidgets(f, state);
        assert.equal(widgets.filter(w => w.element.classList.contains('lsd-editing-preview')).length, 1, `${formula}, caret=${anchor}`);
        assert.ok(widgets.every(w => w.from === w.to), 'revealed source stays editable');
      }
    }
  } finally { f.close(); }
});

test('moving between equations during composition initializes the newly entered preview', async () => {
  const f = await fixture();
  try {
    const text = 'Before \\(x+1\\) and \\(y+2\\).';
    const x = text.indexOf('x+1'), y = text.indexOf('y+2');
    let state = cmState.EditorState.create({doc: text, selection: {anchor: x}, extensions: [f.livePreview, f.api.compositionState, f.api.editingPreviewState, f.api.livePreviewExtension]});
    state = state.update({effects: f.api.setComposing.of(true)}).state;
    state = state.update({selection: {anchor: y}}).state;
    let widgets = editorWidgets(f, state);
    assert.equal(widgets.filter(w => w.element.classList.contains('lsd-editing-preview')).length, 1);
    assert.equal(f.calls.at(-1)!.source, 'y+2');
    state = state.update({selection: {anchor: 0}}).state;
    assert.equal(state.field(f.api.editingPreviewState), null);
    state = state.update({selection: {anchor: x}}).state;
    widgets = editorWidgets(f, state);
    assert.equal(widgets.filter(w => w.element.classList.contains('lsd-editing-preview')).length, 1, 'leaving and re-entering does not latch the preview off');
    assert.equal(f.calls.at(-1)!.source, 'x+1');
  } finally { f.close(); }
});

test('a frozen IME preview maps through multiline edits and is removed after an incomplete formula is committed', async () => {
  const f = await fixture();
  try {
    const text = 'Before\n\n   \\[\n   x+1\n   \\]\nAfter';
    const x = text.indexOf('x+1');
    let state = cmState.EditorState.create({doc: text, selection: {anchor: x}, extensions: [f.livePreview, f.api.compositionState, f.api.editingPreviewState, f.api.livePreviewExtension]});
    const [before] = editorWidgets(f, state);
    state = state.update({effects: f.api.setComposing.of(true)}).state;
    state = state.update({changes: {from: x, insert: 'a+\n   '}}).state;
    let [during] = editorWidgets(f, state);
    assert.ok(before.widget.eq(during.widget));
    assert.equal(during.from, state.doc.lineAt(state.doc.toString().indexOf('\\]')).to);
    const closer = state.doc.toString().indexOf('\\]');
    state = state.update({changes: {from: closer, to: closer + 2}}).state;
    [during] = editorWidgets(f, state);
    assert.ok(before.widget.eq(during.widget), 'temporary incomplete delimiters do not discard the frozen preview');
    state = state.update({effects: f.api.setComposing.of(false)}).state;
    assert.equal(editorWidgets(f, state).length, 0, 'incomplete math remains source after commit');
  } finally { f.close(); }
});

test('disabled previews, source mode, Vim and multiple cursors still suppress the editing preview', async () => {
  const f = await fixture();
  try {
    const text = 'Before \\(x+1\\).';
    const anchor = text.indexOf('x+1');
    const base = [f.api.compositionState, f.api.editingPreviewState, f.api.livePreviewExtension];
    for (const extensions of [
      base,
      [...base, f.livePreview, f.api.renderOptions.of({enabled: true, previews: false})],
      [...base, f.livePreview, f.api.renderOptions.of({enabled: false, previews: true})],
    ]) {
      const state = cmState.EditorState.create({doc: text, selection: {anchor}, extensions});
      assert.ok(editorWidgets(f, state).every(w => !w.element.classList.contains('lsd-editing-preview')));
    }
    let state = cmState.EditorState.create({doc: text, selection: {anchor}, extensions: [...base, f.livePreview, f.api.vimSourceState, cmState.EditorState.allowMultipleSelections.of(true)]});
    state = state.update({effects: f.api.setVimSource.of(true)}).state;
    assert.equal(editorWidgets(f, state).length, 0);
    state = state.update({effects: f.api.setVimSource.of(false), selection: cmState.EditorSelection.create([cmState.EditorSelection.cursor(anchor), cmState.EditorSelection.cursor(anchor + 2)])}).state;
    assert.equal(editorWidgets(f, state).length, 0);
  } finally { f.close(); }
});

for (const entry of ['already-editing', 'mouse', 'touch']) {
test(`real CodeMirror view retains the preview DOM across selections and composition events; entry=${entry}`, async () => {
  const f = await fixture();
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const win = f.dom.window;
  win.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  win.Range.prototype.getBoundingClientRect = () => new win.DOMRect();
  const settle = async () => {
    await new Promise<void>(resolve => win.setTimeout(resolve, 0));
    if (view) await new Promise<void>(resolve => view!.requestMeasure({read: () => null, write: () => queueMicrotask(resolve)}));
    await Promise.resolve();
  };
  const globals: Record<string, unknown> = {
    window: win, document: win.document, MutationObserver: win.MutationObserver,
    Window: win.Window, Node: win.Node, HTMLElement: win.HTMLElement,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {value, configurable: true});
  }
  const {EditorView} = localRequire('@codemirror/view') as typeof import('@codemirror/view');
  let view: EditorView | undefined;
  try {
    const style = win.document.createElement('style');
    style.textContent = readFileSync(resolve(rootPath, 'styles.css'), 'utf8');
    win.document.head.appendChild(style);
    const text = 'Before\n\n1. Item\n\n   \\[\n   x+1\n   \\]\n\nAfter';
    const x = text.indexOf('x+1');
    view = new EditorView({parent: win.document.body, state: cmState.EditorState.create({
      doc: text, selection: {anchor: entry === 'already-editing' ? x : 0},
      extensions: [f.livePreview, f.api.compositionState, f.api.compositionEvents, f.api.editingPreviewState, f.api.livePreviewExtension, f.api.displayLayout],
    })});
    view.focus();
    if (entry !== 'already-editing') {
      view.contentDOM.dispatchEvent(new win.CompositionEvent('compositionstart', {bubbles: true}));
      await settle();
      assert.equal(view.state.field(f.api.compositionState), true);
      assert.equal(view.compositionStarted, true);
      assert.equal(view.composing, false, 'Android can start composition before any text has changed');
      assert.equal(view.dom.querySelector('.lsd-editing-preview'), null);
      const formula = view.dom.querySelector('.lsd-math-container-display')!;
      if (entry === 'touch') {
        for (const type of ['pointerdown', 'pointerup']) formula.dispatchEvent(new win.PointerEvent(type, {
          bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: 10, clientY: 10,
        }));
      } else formula.dispatchEvent(new win.MouseEvent('mousedown', {bubbles: true, cancelable: true, button: 0}));
      formula.dispatchEvent(new win.MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
      await settle();
      assert.equal(view.state.selection.main.head, x, 'first activation skips delimiter-line whitespace and indentation');
    }
    const preview = view.dom.querySelector('.lsd-editing-preview');
    assert.ok(preview);
    assert.equal(win.getComputedStyle(preview).textAlign, 'center');
    assert.equal(win.getComputedStyle(preview).marginTop, '0px', 'block widgets have no vertical margins');
    view.dispatch({selection: {anchor: x, head: x + 1}});
    assert.equal(view.dom.querySelector('.lsd-editing-preview'), preview);
    view.dispatch({selection: {anchor: text.indexOf('\\[') - 3}});
    assert.equal(view.dom.querySelector('.lsd-editing-preview'), preview, 'indentation tap keeps the same DOM');
    view.dispatch({selection: {anchor: x}});
    view.contentDOM.dispatchEvent(new win.CompositionEvent('compositionstart', {bubbles: true}));
    await settle();
    assert.equal(view.state.field(f.api.compositionState), true);
    view.dispatch({changes: {from: x + 1, insert: '2'}});
    assert.equal(view.dom.querySelector('.lsd-editing-preview'), preview, 'actual widget DOM survives an IME text update');
    view.contentDOM.dispatchEvent(new win.CompositionEvent('compositionend', {bubbles: true}));
    await settle();
    assert.equal(view.state.field(f.api.compositionState), false);
    assert.ok(view.dom.querySelector('.lsd-editing-preview'));
    assert.equal(view.dom.querySelector('.lsd-editing-preview'), preview, 'commit retains the preview container');
    assert.ok(f.calls.some(call => call.source.includes('x2+1')), 'commit renders the updated TeX');
    view.dispatch({selection: {anchor: 0}});
    assert.equal(view.dom.querySelector('.lsd-editing-preview'), null);
    const rendered = view.dom.querySelector('.lsd-math-container-display');
    assert.ok(rendered);
    assert.equal(win.getComputedStyle(rendered).textAlign, 'center');
    assert.equal(win.getComputedStyle(rendered).overflowX, 'auto');
    assert.ok(rendered.closest('.cm-line')!.textContent!.startsWith('   '), 'the source indentation remains in the host line');
    assert.equal(view.state.doc.toString(), text.slice(0, x + 1) + '2' + text.slice(x + 1));
  } finally {
    view?.destroy();
    await new Promise<void>(resolve => queueMicrotask(resolve));
    f.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
}
