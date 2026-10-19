import assert from 'node:assert/strict';
import test from 'node:test';
import { readingSectionOffset } from '../src/reading-mapping';

test('list-item layout whitespace maps duplicate equations without changing their content', () => {
  const body = 'Given (x), again (x), and [\\text{a  b}\nx].';
  assert.equal(readingSectionOffset('\n' + body + '\n', '\n\n' + body + '\n\n\n'), -1);
  assert.equal(readingSectionOffset('\n\n' + body + '\n', body), 2);
  assert.equal(readingSectionOffset(body, body), 0);
});

test('reading maps do not collapse internal whitespace or guess repeated fragments', () => {
  assert.equal(readingSectionOffset('(a b)', '(a  b)'), null);
  assert.equal(readingSectionOffset('[a\nb]', '[a b]'), null);
  assert.equal(readingSectionOffset('(x) and (x)', '(x)'), null);
  assert.equal(readingSectionOffset('(x)', ' \n '), null);
  assert.equal(readingSectionOffset('\u0000(x)', '(x)(x)'), null);
});
