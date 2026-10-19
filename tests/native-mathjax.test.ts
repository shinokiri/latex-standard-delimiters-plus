import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import test from 'node:test';
import {sourceHit} from '../src/math-source-map';
import {hasNativeMathJax, nativeMathJax} from './helpers/native-mathjax';
import {findMathDelimiters} from '../src/parser';
import {mathPresentation} from '../src/presentation';

test('installed MathJax produces the tested source annotations and distinguishes actual parser errors', {skip: !hasNativeMathJax}, async () => {
  const native = await nativeMathJax();
  try {
    const examples = JSON.parse(readFileSync(new URL('./fixtures/mathjax-output.json', import.meta.url), 'utf8')).cases as Array<{source: string; html: string}>;
    for (const example of examples) {
      const actual = native.render(example.source);
      const expected = actual.ownerDocument.createElement('div'); expected.innerHTML = example.html;
      const annotations = (root: Element) => Array.from(root.querySelectorAll('[data-latex]')).map(node => [node.localName, node.getAttribute('data-latex')]);
      assert.deepEqual(annotations(actual), annotations(expected), example.source);
    }
    const source = String.raw`\frac{a}{a}+a`, rendered = native.render(source);
    const targets = Array.from(rendered.querySelectorAll('[data-latex="a"]'));
    assert.deepEqual(targets.map(target => sourceHit(rendered, source, {target, x: 0, y: 0})?.caret), [6, 9, 12]);
    const error = native.render(String.raw`x+\frac{`);
    assert.ok(error.querySelector('mjx-merror, [data-mjx-error], .mjx-merror'));
  } finally { native.close(); }
});

const privateNote = new URL('../.local-fixtures/probability-list.md', import.meta.url);
test('private note source navigation uses actual MathJax without mistaking expanded iff commands', {skip: !hasNativeMathJax || !existsSync(privateNote)}, async () => {
  const native = await nativeMathJax();
  try {
    const text = readFileSync(privateNote, 'utf8'), matches = findMathDelimiters(text);
    assert.equal(matches.length, 33);
    for (const match of matches) {
      const source = mathPresentation(text, match).source;
      const rendered = native.render(source);
      assert.equal(rendered.querySelector('mjx-merror, [data-mjx-error]'), null);
      const leaves = Array.from(rendered.querySelectorAll('[data-latex]')).filter(node => node.localName !== 'mjx-math' && !node.querySelector('[data-latex]'));
      for (const target of leaves) {
        const hit = sourceHit(rendered, source, {target, x: 0, y: 0});
        assert.ok(hit);
        const original = source.slice(hit.from, hit.to).replace(/\s/g, '');
        const annotation = target.getAttribute('data-latex')!.replace(/\s/g, '');
        assert.ok(original === annotation || original === String.raw`\iff` && [String.raw`\;`, String.raw`\Longleftrightarrow`].includes(annotation));
      }
    }
  } finally { native.close(); }
});
