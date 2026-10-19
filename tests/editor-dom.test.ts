import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import type { Decoration, DecorationSet, EditorView, ViewUpdate } from '@codemirror/view';
import type { Extension, StateField } from '@codemirror/state';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const nativePath = resolve(root, '.local-fixtures/native-codemirror.js');
const runtimes = existsSync(nativePath) ? ['npm', 'installed-obsidian'] : ['npm'];
const bundle = build({
  stdin: {
    contents: readFileSync(resolve(root, 'src/main.ts'), 'utf8') + '\nexport {compositionState, compositionEvents, editingPreviewState, livePreviewExtension, findMathDelimiters};',
    loader: 'ts', resolveDir: resolve(root, 'src'),
  }, bundle: true, packages: 'external', platform: 'browser', format: 'cjs', write: false,
});

// The optional local core is extracted from the user's installed APK for
// compatibility checks. It is never distributed. Neither runtime is a device
// or a layout test; MathJax is represented by a nested, uneditable widget.
const mathExamples = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/mathjax-output.json'), 'utf8')).cases as Array<{source: string; html: string}>;
async function fixture(runtime: string, doc = 'Before \\(x+1\\) and \\(y+2\\).\n\n   \\[\n   A=B\n   \\]\n\nAfter \\(A\\).', mathHTML?: (source: string) => string | undefined, initialCaret = 0, sourceFormatting = false) {
  const dom = new JSDOM('<!doctype html><body></body>', {pretendToBeVisual: true});
  const win = dom.window;
  Object.defineProperty(win.navigator, 'userAgent', {value: 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36'});
  Object.defineProperty(win.Node.prototype, 'instanceOf', {value(this: Node, ctor: typeof Node) { return this instanceof ctor; }});
  win.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  win.Range.prototype.getBoundingClientRect = () => new win.DOMRect();
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const browser = {
    window: win, document: win.document, navigator: win.navigator, MutationObserver: win.MutationObserver,
    Window: win.Window, Node: win.Node, HTMLElement: win.HTMLElement, KeyboardEvent: win.KeyboardEvent,
    getComputedStyle: win.getComputedStyle.bind(win), requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  };
  for (const [name, value] of Object.entries(browser)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {value, configurable: true});
  }
  const modules: Record<string, unknown> = {};
  if (runtime === 'installed-obsidian') {
    const context = {...browser, console, queueMicrotask, setTimeout, clearTimeout,
      fetch: () => { throw new Error('No network in isolated editor fixture'); }, nativeModules: modules};
    vm.runInNewContext(readFileSync(nativePath, 'utf8'), context);
    Object.assign(modules, context.nativeModules);
  } else for (const name of ['state', 'view', 'language']) modules['@codemirror/' + name] = require('@codemirror/' + name);
  const stateModule = modules['@codemirror/state'] as typeof import('@codemirror/state');
  const viewModule = modules['@codemirror/view'] as typeof import('@codemirror/view');
  const languageModule = modules['@codemirror/language'] as typeof import('@codemirror/language');
  // A small host-formatting fixture, not the entire Obsidian Markdown parser.
  // The installed host uses empty replacements for escape backslashes outside
  // selected rows and freezes those replacements during composition. Unlike
  // the default empty syntax tree, this exposes interactions with our markers.
  const formatting: Extension[] = sourceFormatting ? [languageModule.StreamLanguage.define({
    tokenTable: {'formatting-escape': [], 'formatting-em': []},
    mergeTokens: false,
    token(stream) {
      const char = stream.next();
      if (char === '\\' && /[()[\]{}_*\\]/.test(stream.peek() ?? '')) return 'formatting-escape escape';
      if (char === '_' || char === '*') return 'formatting-em emphasis';
      return null;
    },
  }), viewModule.ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = this.build(view); }
    update(update: ViewUpdate) {
      this.decorations = update.view.composing ? this.decorations.map(update.changes) : this.build(update.view);
    }
    build(view: EditorView) {
      const ranges: ReturnType<Decoration['range']>[] = [];
      languageModule.syntaxTree(view.state).iterate({enter(node) {
        if (!node.name.includes('formatting-escape') && !node.name.includes('formatting-em')) return;
        const row = view.state.doc.lineAt(node.from);
        // Model the focused-editor branch, including in the fresh view used
        // to compare DOM output without moving the actual browser selection.
        if (view.state.selection.ranges.some(range => range.from <= row.to && range.to >= row.from)) return;
        ranges.push(viewModule.Decoration.replace({}).range(node.from, node.to));
      }});
      return viewModule.Decoration.set(ranges, true);
    }
  }, {decorations: plugin => plugin.decorations})] : [];
  const livePreview = stateModule.StateField.define({create: () => true, update: value => value});
  class Component {}
  const host = {Component, MarkdownRenderChild: Component, Plugin: Component, Modal: Component, PluginSettingTab: Component,
    editorLivePreviewField: livePreview, loadMathJax: async () => {}, finishRenderMath: async () => {},
    renderMath(source: string) {
      if (source.includes('BROKEN')) throw new Error('Synthetic render error');
      const html = mathHTML?.(source);
      if (html) {
        const fragment = win.document.createElement('div'); fragment.innerHTML = html;
        const output = fragment.firstElementChild as HTMLElement; output.dataset.tex = source;
        return output;
      }
      const result = win.document.createElement('mjx-container');
      const text = result.appendChild(win.document.createElement('mjx-math'));
      text.textContent = '⟪' + source + '⟫'; result.dataset.tex = source;
      return result;
    },
  };
  const module = {exports: {}};
  vm.runInNewContext((await bundle).outputFiles[0].text, {...browser, console, queueMicrotask, Text: win.Text,
    module, exports: module.exports, require: (name: string) => name === 'obsidian' ? host : modules[name]});
  const api = module.exports as {
    compositionState: StateField<boolean>; compositionEvents: Extension; editingPreviewState: Extension; livePreviewExtension: Extension;
    findMathDelimiters(text: string): Array<{from: number; to: number; source: string; display: boolean}>;
  };
  const view = new viewModule.EditorView({parent: win.document.body, state: stateModule.EditorState.create({doc, selection: {anchor: initialCaret},
    extensions: [livePreview, ...formatting, api.compositionState, api.compositionEvents, api.editingPreviewState, api.livePreviewExtension]})});
  view.focus();
  const settle = async () => {
    await new Promise<void>(resolve => win.setTimeout(resolve, 0));
    await new Promise<void>(resolve => view.requestMeasure({read: () => null, write: () => queueMicrotask(resolve)}));
    await Promise.resolve();
  };
  function insertDOM(position: number, text: string) {
    const at = view.domAtPos(position);
    assert.equal(at.node.nodeType, 3, 'IME edits actual source text');
    (at.node as Text).insertData(at.offset, text);
    win.getSelection()!.collapse(at.node, at.offset + text.length);
  }
  function replaceDOM(from: number, to: number, text: string) {
    const start = view.domAtPos(from), end = view.domAtPos(to);
    const range = win.document.createRange();
    range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
    range.deleteContents();
    const node = win.document.createTextNode(text);
    range.insertNode(node); win.getSelection()!.collapse(node, text.length);
    view.contentDOM.dispatchEvent(new win.InputEvent('input', {bubbles: true, inputType: 'insertCompositionText', data: text, isComposing: view.compositionStarted}));
    return node;
  }
  function assertConsistent(label: string) {
    const fresh = new viewModule.EditorView({parent: win.document.body, state: view.state});
    try {
      assert.equal(view.contentDOM.textContent, fresh.contentDOM.textContent, label + ': no duplicate or misplaced text');
      assert.equal(view.dom.querySelectorAll('.lsd-math').length, fresh.dom.querySelectorAll('.lsd-math').length, label + ': no duplicate widgets');
    } finally { fresh.destroy(); }
  }
  async function close() {
    view.destroy(); await Promise.resolve(); dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
  return {dom, win, api, view: view as EditorView, doc, settle, insertDOM, replaceDOM, assertConsistent, close};
}

for (const runtime of runtimes) {
  test(`source delimiters stay visible when IME starts before typing on another row; ${runtime}`, async () => {
    const doc = 'Before\n\n   \\[\n   abc\n   \\]\n\nAfter';
    for (const startBeforeTap of [false, true]) {
      const f = await fixture(runtime, doc, undefined, 0, true);
      try {
        if (startBeforeTap) {
          f.view.contentDOM.dispatchEvent(new f.win.CompositionEvent('compositionstart', {bubbles: true}));
          await f.settle();
        }
        f.view.dom.querySelector('.lsd-math')!.dispatchEvent(new f.win.MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
        await f.settle();
        const original = Array.from(f.view.dom.querySelectorAll('.lsd-math-source-marker'));
        assert.equal(original.length, 2, 'both delimiter backslashes override hidden Markdown escapes');
        const assertSource = () => {
          const lines = Array.from(f.view.contentDOM.querySelectorAll('.cm-line'), line => line.textContent);
          for (const row of ['   \\[', '   abc', '   \\]']) assert.ok(lines.includes(row), 'visible source row: ' + row);
          assert.equal(f.view.state.doc.toString(), doc);
          assert.ok(f.view.dom.querySelector('.lsd-editing-preview'));
        };
        assertSource();
        if (!startBeforeTap) {
          f.view.contentDOM.dispatchEvent(new f.win.CompositionEvent('compositionstart', {bubbles: true}));
          await f.settle();
        }
        assert.equal(f.view.state.field(f.api.compositionState), true);
        assertSource();
        assert.deepEqual(Array.from(f.view.dom.querySelectorAll('.lsd-math-source-marker')), original, 'starting an IME must not remove and recreate delimiter DOM');
        f.view.contentDOM.dispatchEvent(new f.win.CompositionEvent('compositionend', {bubbles: true}));
        await f.settle();
        assertSource();
        f.assertConsistent('idle composition with Markdown escape hiding');
      } finally { await f.close(); }
    }
  });

  test(`literal source markers preserve IME-owned text while punctuation is composed; ${runtime}`, async () => {
    const doc = 'Before\n\n   \\[\n   abc\n   \\]\n\nAfter';
    const position = doc.indexOf('abc');
    const f = await fixture(runtime, doc, undefined, position + 1, true);
    try {
      const delimiters = Array.from(f.view.dom.querySelectorAll('.lsd-math-source-marker'));
      const at = f.view.domAtPos(position + 1);
      assert.equal(at.node.nodeType, 3);
      const owned = at.node as Text;
      const prefix = owned.data.slice(0, at.offset - 1);
      assert.equal(owned.data, prefix + 'abc');
      f.win.getSelection()!.collapse(owned, at.offset);
      f.view.contentDOM.dispatchEvent(new f.win.CompositionEvent('compositionstart', {bubbles: true}));
      await f.settle();
      for (const text of ['a_bc', 'a_b\\{字\\}c', 'a_b\\{字\\}']) {
        // Browser/IME changes its own text node, including characters that
        // Markdown would normally hide. It must not be replaced by widgets.
        assert.ok(owned.isConnected);
        owned.data = prefix + text; f.win.getSelection()!.collapse(owned, owned.length);
        f.view.contentDOM.dispatchEvent(new f.win.InputEvent('input', {bubbles: true, inputType: 'insertCompositionText', data: text, isComposing: true}));
        await f.settle();
        assert.equal(f.view.state.doc.toString(), doc.slice(0, position) + text + doc.slice(position + 3));
        assert.ok(owned.isConnected, 'CodeMirror retains the exact composing text node');
        assert.equal(owned.data, prefix + text);
        assert.deepEqual(Array.from(f.view.dom.querySelectorAll('.lsd-math-source-marker')), delimiters, 'new source markers cannot split the composing text');
        f.assertConsistent('composition with TeX punctuation');
      }
      f.view.contentDOM.dispatchEvent(new f.win.CompositionEvent('compositionend', {bubbles: true}));
      await f.settle();
      assert.equal(f.view.state.field(f.api.compositionState), false);
      const expected = doc.slice(0, position) + 'a_b\\{字\\}' + doc.slice(position + 3);
      assert.equal(f.view.state.doc.toString(), expected);
      assert.ok(Array.from(f.view.contentDOM.querySelectorAll('.cm-line'), line => line.textContent).includes('   a_b\\{字\\}'));
      f.assertConsistent('committed TeX punctuation');
    } finally { await f.close(); }
  });

  test(`IME replacement across source markers and delimiter deletion do not restore old text; ${runtime}`, async () => {
    for (const formula of ['\\(x_y+\\{z\\}\\)', '   \\[\n   x_y+\\{z\\}\n   \\]']) {
      const doc = 'Before\n\n' + formula + '\n\nAfter';
      const position = doc.indexOf('x_y'), end = doc.indexOf('z\\}') + 3;
      const f = await fixture(runtime, doc, undefined, position, true);
      try {
        const replacement = 'a_b+\\{中\\}';
        f.view.dispatch({selection: {anchor: position, head: end}});
        f.view.contentDOM.dispatchEvent(new f.win.CompositionEvent('compositionstart', {bubbles: true}));
        const owned = f.replaceDOM(position, end, replacement);
        await f.settle();
        const expected = doc.slice(0, position) + replacement + doc.slice(end);
        assert.equal(f.view.state.doc.toString(), expected);
        assert.ok(owned.isConnected);
        assert.equal(owned.data, replacement);
        f.view.contentDOM.dispatchEvent(new f.win.CompositionEvent('compositionend', {bubbles: true}));
        await f.settle();
        f.assertConsistent('replacing across literal markers');
        const match = f.api.findMathDelimiters(expected)[0];
        f.view.dispatch({selection: {anchor: match.from, head: match.from + 1}});
        f.view.contentDOM.dispatchEvent(new f.win.CompositionEvent('compositionstart', {bubbles: true}));
        f.replaceDOM(match.from, match.from + 1, '');
        await f.settle();
        f.view.contentDOM.dispatchEvent(new f.win.CompositionEvent('compositionend', {bubbles: true}));
        await f.settle();
        assert.equal(f.view.state.doc.toString(), expected.slice(0, match.from) + expected.slice(match.from + 1), 'intentional deletion stays deleted');
        assert.equal(f.view.dom.querySelector('.lsd-editing-preview'), null, 'an incomplete delimiter pair no longer renders');
        f.assertConsistent('deleting the opening backslash');
      } finally { await f.close(); }
    }
  });

  test(`an editor reopened inside a formula remembers its initial caret; ${runtime}`, async () => {
    const doc = 'Before \\(abcdef\\).';
    const position = doc.indexOf('abcdef') + 3;
    const f = await fixture(runtime, doc, undefined, position);
    try {
      f.view.dispatch({selection: {anchor: 0}});
      f.view.dom.querySelector('.lsd-math')!.dispatchEvent(new f.win.MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
      await f.settle();
      assert.equal(f.view.state.selection.main.head, position);
      assert.equal(f.view.state.doc.toString(), doc);
    } finally { await f.close(); }
  });

  test(`clicking rendered symbols and the editing preview follows the correct source occurrence; ${runtime}`, async () => {
    const source = String.raw`(A\cap B)\cup(A\cap B^c)=A.`;
    const doc = 'Before \\(' + source + '\\).\n\nAfter';
    const f = await fixture(runtime, doc, source => mathExamples.find(item => item.source === source)?.html);
    try {
      const rendered = f.view.dom.querySelector('.lsd-math')!;
      const symbols = Array.from(rendered.querySelectorAll('[data-latex="B"]'));
      symbols[1].querySelector('mjx-c')!.dispatchEvent(new f.win.MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
      await f.settle();
      assert.equal(f.view.state.selection.main.head, doc.indexOf('B^c'));
      assert.equal(f.view.state.selection.main.empty, true);
      const preview = f.view.dom.querySelector('.lsd-editing-preview')!;
      assert.ok(preview);
      const c = preview.querySelector('[data-latex="c"] mjx-c')!;
      c.dispatchEvent(new f.win.MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
      await f.settle();
      assert.equal(f.view.state.selection.main.head, doc.indexOf('^c') + 1);
      assert.equal(f.view.dom.querySelector('.lsd-editing-preview'), preview);
      await f.settle();
      assert.equal(preview.querySelector('.lsd-math-focus')?.getAttribute('data-latex'), 'c');
      assert.equal(f.view.state.doc.toString(), doc);
      f.assertConsistent('symbol and preview activation');
    } finally { await f.close(); }
  });

  test(`blank clicks remember each formula independently and follow preceding edits; ${runtime}`, async () => {
    const doc = 'Before \\(abcdef\\) and \\(abcdef\\).';
    const f = await fixture(runtime, doc);
    try {
      const first = doc.indexOf('abcdef'), second = doc.lastIndexOf('abcdef');
      f.view.dispatch({selection: {anchor: first + 2}});
      f.view.dispatch({selection: {anchor: second + 4}});
      f.view.dispatch({selection: {anchor: 0}});
      f.view.dispatch({changes: {from: 0, insert: 'Prefix '}});
      for (const [index, expected] of [[1, second + 4 + 7], [0, first + 2 + 7]]) {
        f.view.dispatch({selection: {anchor: 0}});
        f.view.dom.querySelectorAll('.lsd-math')[index].dispatchEvent(new f.win.MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
        await f.settle();
        assert.equal(f.view.state.selection.main.head, expected);
        assert.equal(f.view.state.selection.main.empty, true);
      }
      assert.equal(f.view.state.doc.toString(), 'Prefix ' + doc);
    } finally { await f.close(); }
  });

  test(`preview updates retain their container and recover from a temporarily invalid formula; ${runtime}`, async () => {
    const f = await fixture(runtime, 'Before \\(x+1\\).');
    try {
      const start = f.doc.indexOf('x+1');
      f.view.dispatch({selection: {anchor: start}});
      const preview = f.view.dom.querySelector('.lsd-editing-preview')!;
      f.view.dispatch({changes: {from: start, to: start + 3, insert: 'BROKEN'}});
      await f.settle();
      assert.equal(f.view.dom.querySelector('.lsd-editing-preview'), preview);
      assert.ok(preview.classList.contains('lsd-preview-stale'));
      assert.equal(preview.querySelector('mjx-container')?.getAttribute('data-tex'), 'x+1');
      const before = f.view.state.selection.main.head;
      preview.querySelector('mjx-math')!.dispatchEvent(new f.win.MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
      await f.settle();
      assert.equal(f.view.state.selection.main.head, before, 'stale output cannot navigate into changed source');
      f.view.dispatch({changes: {from: start, to: start + 6, insert: 'x+2'}});
      await f.settle();
      assert.equal(f.view.dom.querySelector('.lsd-editing-preview'), preview);
      assert.equal(preview.classList.contains('lsd-preview-stale'), false);
      assert.equal(preview.querySelector('mjx-container')?.getAttribute('data-tex'), 'x+2');
      f.assertConsistent('valid preview after invalid input');
    } finally { await f.close(); }
  });

  test(`a pending preview click cannot pull back a newer source selection; ${runtime}`, async () => {
    const source = String.raw`\frac{a}{a}+a`;
    const f = await fixture(runtime, 'Before \\(' + source + '\\).', source => mathExamples.find(item => item.source === source)?.html);
    try {
      const start = f.doc.indexOf(source);
      f.view.dispatch({selection: {anchor: start}});
      const preview = f.view.dom.querySelector('.lsd-editing-preview')!;
      preview.querySelector('[data-latex="a"]')!.dispatchEvent(new f.win.MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
      // The next task queues activation, but its measurement has not run yet.
      await new Promise<void>(resolve => f.win.setTimeout(resolve, 0));
      const target = start + source.length;
      f.view.dispatch({selection: {anchor: target}});
      await f.settle();
      assert.equal(f.view.state.selection.main.head, target);
      assert.equal(f.view.state.doc.toString(), f.doc);
    } finally { await f.close(); }
  });

  test(`switching equations never carries another equation's last valid preview; ${runtime}`, async () => {
    const doc = 'Before \\(x+1\\) and \\(BROKEN\\).';
    const f = await fixture(runtime, doc);
    try {
      f.view.dispatch({selection: {anchor: doc.indexOf('x+1')}});
      assert.equal(f.view.dom.querySelector('.lsd-editing-preview mjx-container')?.getAttribute('data-tex'), 'x+1');
      f.view.dispatch({selection: {anchor: doc.indexOf('BROKEN')}});
      await f.settle();
      const preview = f.view.dom.querySelector('.lsd-editing-preview')!;
      assert.equal(preview.querySelector('[data-tex="x+1"]'), null, 'a different equation cannot inherit the previous result');
      assert.equal(preview.classList.contains('lsd-preview-stale'), false);
      assert.ok(preview.classList.contains('lsd-render-error'));
      assert.equal(f.view.state.doc.toString(), doc);
    } finally { await f.close(); }
  });

  test(`pending browser edit survives compositionstart; ${runtime}`, async () => {
    for (const formatting of [false, true]) {
      const f = await fixture(runtime, undefined, undefined, 0, formatting);
      try {
        const position = f.doc.indexOf('x+1') + 1;
        f.view.dispatch({selection: {anchor: position}});
        f.insertDOM(position, 'k');
        // Android may normalize/replace text before firing compositionstart.
        // Dispatching synchronously here clears CodeMirror's unread mutations.
        f.view.contentDOM.dispatchEvent(new f.win.CompositionEvent('compositionstart', {bubbles: true}));
        await f.settle();
        assert.equal(f.view.state.doc.toString(), f.doc.slice(0, position) + 'k' + f.doc.slice(position));
        f.assertConsistent('compositionstart');
      } finally { await f.close(); }
    }
  });

  test(`final browser edit after compositionend survives the preview refresh; ${runtime}`, async () => {
    for (const formatting of [false, true]) {
      const f = await fixture(runtime, undefined, undefined, 0, formatting);
      try {
        const position = f.doc.indexOf('x+1') + 1;
        f.view.dispatch({selection: {anchor: position}});
        f.view.contentDOM.dispatchEvent(new f.win.CompositionEvent('compositionstart', {bubbles: true}));
        await f.settle();
        f.view.contentDOM.dispatchEvent(new f.win.CompositionEvent('compositionend', {bubbles: true}));
        f.insertDOM(position, 'k');
        await f.settle();
        assert.equal(f.view.state.doc.toString(), f.doc.slice(0, position) + 'k' + f.doc.slice(position));
        assert.equal(f.view.state.field(f.api.compositionState), false);
        f.assertConsistent('compositionend');
      } finally { await f.close(); }
    }
  });

  test(`rendered MathJax selection is isolated from Markdown input; ${runtime}`, async () => {
    const f = await fixture(runtime);
    try {
      const math = f.view.dom.querySelector('mjx-math')!;
      f.win.getSelection()!.collapse(math.firstChild, 1);
      f.win.document.dispatchEvent(new f.win.Event('selectionchange'));
      math.dispatchEvent(new f.win.CompositionEvent('compositionstart', {bubbles: true}));
      await f.settle();
      assert.equal(f.view.state.selection.main.head, 0);
      assert.equal(f.view.compositionStarted, false, 'rendered glyphs cannot start an editor composition');
      assert.equal(f.view.state.doc.toString(), f.doc);
      f.assertConsistent('selection inside rendered math');
    } finally { await f.close(); }
  });

  test(`tapping another formula commits pending input and follows its shifted position; ${runtime}`, async () => {
    const f = await fixture(runtime);
    try {
      const position = f.doc.indexOf('x+1') + 1;
      const next = f.api.findMathDelimiters(f.doc)[1];
      f.view.dispatch({selection: {anchor: position}});
      f.view.contentDOM.dispatchEvent(new f.win.CompositionEvent('compositionstart', {bubbles: true}));
      await f.settle();
      const target = Array.from(f.view.dom.querySelectorAll<HTMLElement>('.lsd-math:not(.lsd-editing-preview)')).find(element => f.view.posAtDOM(element) === next.from)!;
      f.view.contentDOM.dispatchEvent(new f.win.CompositionEvent('compositionend', {bubbles: true}));
      f.insertDOM(position, 'k');
      for (const type of ['pointerdown', 'pointerup']) target.dispatchEvent(new f.win.PointerEvent(type, {
        bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: 10, clientY: 10,
      }));
      target.dispatchEvent(new f.win.MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
      await f.settle();
      assert.equal(f.view.state.doc.toString(), f.doc.slice(0, position) + 'k' + f.doc.slice(position));
      assert.equal(f.view.state.selection.main.head, next.from + 3, 'the tap follows the committed edit');
      assert.equal(f.view.dom.querySelector('.lsd-editing-preview mjx-container')?.getAttribute('data-tex'), 'y+2');
      f.assertConsistent('switch after pending input');
    } finally { await f.close(); }
  });

  test(`repeated touch activation and source selection do not accumulate widgets or alter text; ${runtime}`, async () => {
    const f = await fixture(runtime);
    try {
      const matches = f.api.findMathDelimiters(f.doc);
      for (let round = 0; round < 3; round++) for (const match of matches) {
        f.view.dispatch({selection: {anchor: 0}});
        f.view.contentDOM.dispatchEvent(new f.win.CompositionEvent('compositionstart', {bubbles: true}));
        await f.settle();
        const rendered = Array.from(f.view.dom.querySelectorAll<HTMLElement>('.lsd-math')).find(element => f.view.posAtDOM(element) === match.from)!;
        assert.ok(rendered);
        for (const type of ['pointerdown', 'pointerup']) rendered.dispatchEvent(new f.win.PointerEvent(type, {
          bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: 10, clientY: 10,
        }));
        assert.equal(rendered.isConnected, true, 'pointerup retains its native event target');
        for (const type of ['mousedown', 'mouseup', 'click']) rendered.dispatchEvent(new f.win.MouseEvent(type, {bubbles: true, cancelable: true, button: 0}));
        assert.equal(rendered.isConnected, true, 'click finishes before replacing the target');
        await f.settle();
        const expectedStart = round === 0 && match.display ? f.doc.indexOf('A=B') : match.from + 2;
        assert.equal(f.view.state.selection.main.head, expectedStart, JSON.stringify({round, match, composing: f.view.composing,
          started: f.view.compositionStarted, connected: rendered.isConnected, position: rendered.isConnected ? f.view.posAtDOM(rendered) : null}));
        assert.equal(f.view.dom.querySelectorAll('.lsd-editing-preview').length, 1);
        assert.equal(f.view.dom.querySelectorAll('.lsd-math:not(.lsd-editing-preview)').length, matches.length - 1);
        f.assertConsistent('touch activation');
        const preview = f.view.dom.querySelector('.lsd-editing-preview');
        for (const position of [match.from + 3, match.to - 2, match.from + 2]) {
          const at = f.view.domAtPos(position);
          f.win.getSelection()!.collapse(at.node, at.offset);
          f.win.document.dispatchEvent(new f.win.Event('selectionchange'));
          await f.settle();
          assert.equal(f.view.state.selection.main.head, position);
          assert.equal(f.view.dom.querySelector('.lsd-editing-preview'), preview);
        }
        f.assertConsistent('source selections');
        f.view.contentDOM.dispatchEvent(new f.win.CompositionEvent('compositionend', {bubbles: true}));
        await f.settle();
        assert.equal(f.view.state.doc.toString(), f.doc, 'tapping must never edit Markdown');
      }
    } finally { await f.close(); }
  });
}
