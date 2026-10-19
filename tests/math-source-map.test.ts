import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {JSDOM} from 'jsdom';
import {sourceHit, highlightSource, invalidateSourceMap, firstSourcePosition, sourceToDocument, documentToSource} from '../src/math-source-map';
import {findMathDelimiters} from '../src/parser';
import {mathPresentation} from '../src/presentation';

export const examples = JSON.parse(readFileSync(new URL('./fixtures/mathjax-output.json', import.meta.url), 'utf8')).cases as Array<{source: string; html: string}>;

function fixture(source: string, html = examples.find(item => item.source === source)?.html) {
  assert.ok(html, source);
  const dom = new JSDOM('<!doctype html><body><div></div></body>');
  const root = dom.window.document.querySelector('div')!;
  root.innerHTML = html;
  function nodes(tex: string) { return Array.from(root.querySelectorAll('[data-latex]')).filter(node => node.getAttribute('data-latex') === tex && node.localName !== 'mjx-math'); }
  function hit(node: Element, right = false) {
    const glyph = node.querySelector('mjx-c') ?? node;
    for (const target of [node, glyph]) target.getBoundingClientRect = () => new dom.window.DOMRect(10, 10, 20, 20);
    return sourceHit(root, source, {target: glyph, x: right ? 26 : 14, y: 20});
  }
  return {dom, root, nodes, hit, close: () => dom.window.close()};
}

test('real MathJax output distinguishes repeated set symbols and keeps commands atomic', () => {
  const source = String.raw`(A\cap B)\cup(A\cap B^c)=A.`;
  const f = fixture(source);
  try {
    const a = f.nodes('A');
    assert.equal(a.length, 3);
    assert.equal(f.hit(a[0])?.caret, 1);
    assert.equal(f.hit(a[1])?.caret, source.indexOf('(A', 1) + 1);
    assert.equal(f.hit(a[2], true)?.caret, source.lastIndexOf('A') + 1);
    const b = f.nodes('B');
    assert.equal(f.hit(b[1])?.caret, source.indexOf('B^c'));
    assert.equal(f.hit(f.nodes('c')[0])?.caret, source.indexOf('^c') + 1);
    const caps = f.nodes(String.raw`\cap`);
    assert.equal(f.hit(caps[1])?.caret, source.lastIndexOf(String.raw`\cap`));
    assert.equal(f.hit(caps[1], true)?.caret, source.lastIndexOf(String.raw`\cap`) + 4);
    assert.equal(sourceHit(f.root, source, {target: f.root, x: 0, y: 0}), null, 'blank space does not invent a source offset');
  } finally { f.close(); }
});

test('fractions, roots and repeated aligned rows map to their own source occurrence', () => {
  for (const source of [String.raw`\frac{a}{a}+a`, String.raw`\sqrt[x]{x}`, String.raw`\begin{aligned}x&=a+b\\ y&=a+b\end{aligned}`]) {
    const f = fixture(source);
    try {
      if (source.startsWith('\\frac')) {
        const nodes = f.nodes('a');
        assert.deepEqual(nodes.map(node => f.hit(node)?.caret), [source.indexOf('{a}') + 1, source.lastIndexOf('{a}') + 1, source.length - 1]);
      } else if (source.startsWith('\\sqrt')) {
        assert.deepEqual(f.nodes('x').map(node => f.hit(node)?.caret), [source.indexOf('[x]') + 1, source.indexOf('{x}') + 1]);
      } else {
        assert.deepEqual(f.nodes('a').map(node => f.hit(node)?.caret), [source.indexOf('=a') + 1, source.lastIndexOf('=a') + 1]);
      }
    } finally { f.close(); }
  }
});

test('built-in logical relation expansions map back to their original whole commands', () => {
  for (const [source, command, arrow] of [
    [String.raw`p\iff q\iff p`, String.raw`\iff`, String.raw`\Longleftrightarrow`],
    [String.raw`p\implies q`, String.raw`\implies`, String.raw`\Longrightarrow`],
    [String.raw`p\impliedby q`, String.raw`\impliedby`, String.raw`\Longleftarrow`],
  ]) {
    const f = fixture(source);
    try {
      const arrows = f.nodes(arrow);
      for (let i = 0; i < arrows.length; i++) {
        const at = i === 0 ? source.indexOf(command) : source.lastIndexOf(command);
        assert.equal(f.hit(arrows[i])?.caret, at);
        assert.equal(f.hit(arrows[i], true)?.caret, at + command.length);
      }
      assert.equal(f.hit(f.nodes('p')[0])?.caret, 0);
      if (f.nodes('p').length > 1) assert.equal(f.hit(f.nodes('p')[1])?.caret, source.length - 1);
    } finally { f.close(); }
  }
});

test('superscripts, subscripts and limits use source roles rather than visual order', () => {
  for (const source of ['x_x^x', 'x^x_x', String.raw`\sum_{i=1}^n x_i`]) {
    const f = fixture(source);
    try {
      if (source.startsWith('x')) {
        assert.deepEqual(f.nodes('x').map(node => f.hit(node)?.caret), [0, source.indexOf('^x') + 1, source.indexOf('_x') + 1]);
      } else {
        assert.equal(f.hit(f.nodes('n')[0])?.caret, source.indexOf('^n') + 1);
        assert.equal(f.hit(f.nodes(String.raw`\sum`)[0])?.caret, 0);
        assert.deepEqual(f.nodes('i').map(node => f.hit(node)?.caret), [source.indexOf('{i') + 1, source.lastIndexOf('_i') + 1]);
      }
    } finally { f.close(); }
  }
});

test('macro expansion, comments, ambiguous occurrences and absent annotations fall back without false matches', () => {
  const cases = [
    {source: String.raw`\newcommand{\dup}[1]{#1+#1}\dup{x}`},
    {source: String.raw`\foo+x`, html: '<mjx-math><mjx-mi data-latex="x"><mjx-c>x</mjx-c></mjx-mi><mjx-mo data-latex="+">+</mjx-mo><mjx-mi data-latex="x"><mjx-c>x</mjx-c></mjx-mi></mjx-math>'},
    {source: 'x+x', html: '<mjx-math><mjx-mi data-latex="x"><mjx-c>x</mjx-c></mjx-mi></mjx-math>'},
    {source: 'x', html: '<mjx-math><mjx-mi><mjx-c>x</mjx-c></mjx-mi></mjx-math>'},
  ];
  for (const item of cases) {
    const f = fixture(item.source, item.html);
    try {
      for (const node of f.root.querySelectorAll('mjx-c')) assert.equal(f.hit(node), null, item.source);
    } finally { f.close(); }
  }
  const f = fixture('a % a\n+a', '<mjx-math><mjx-mi data-latex="a"><mjx-c>a</mjx-c></mjx-mi><mjx-mo data-latex="+">+</mjx-mo><mjx-mi data-latex="a"><mjx-c>a</mjx-c></mjx-mi></mjx-math>');
  try { assert.deepEqual(f.nodes('a').map(node => f.hit(node)?.caret), [0, 7]); }
  finally { f.close(); }
});

test('character hits and highlighting use Unicode boundaries and fresh DOM after render updates', () => {
  const f = fixture('123', '<mjx-math><mjx-mn data-latex="123"><mjx-c>1</mjx-c><mjx-c>2</mjx-c><mjx-c>3</mjx-c></mjx-mn></mjx-math>');
  try {
    const glyph = f.root.querySelectorAll('mjx-c')[1];
    assert.equal(f.hit(glyph)?.caret, 1);
    assert.equal(f.hit(glyph, true)?.caret, 2);
    highlightSource(f.root, '123', 2);
    assert.equal(f.root.querySelectorAll('.lsd-math-focus').length, 1);
    const old = f.root.innerHTML;
    f.root.innerHTML = old;
    invalidateSourceMap(f.root);
    highlightSource(f.root, '123', null);
    assert.equal(f.root.querySelectorAll('.lsd-math-focus').length, 0);
  } finally { f.close(); }
  const u = fixture('𝑥', '<mjx-math><mjx-mi data-latex="𝑥"><mjx-c>𝑥</mjx-c></mjx-mi></mjx-math>');
  try { assert.equal(u.hit(u.nodes('𝑥')[0], true)?.caret, 2); }
  finally { u.close(); }
});

test('source positions project through quote/list prefixes and skip initial whitespace', () => {
  const text = '1. Item\n\n   \\[\n   \\frac{a}{a}\n   \\]\n\n> \\[\n> x_x^x\n> \\]';
  for (const match of findMathDelimiters(text)) {
    const presentation = mathPresentation(text, match);
    const start = firstSourcePosition(presentation)!;
    assert.ok(text.slice(start).startsWith(match.source.includes('frac') ? '\\frac' : 'x_x'));
    for (const token of ['a', 'x']) for (const m of presentation.source.matchAll(new RegExp(token, 'g'))) {
      const position = sourceToDocument(presentation, m.index)!;
      assert.equal(text[position], token);
      assert.equal(documentToSource(presentation, position), m.index);
    }
  }
});
