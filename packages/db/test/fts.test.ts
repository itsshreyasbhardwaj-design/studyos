import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ftsQuery } from '../src/fts.ts';

test('words become quoted phrases, with the last one prefix-matched', () => {
  assert.equal(ftsQuery('dot product'), '"dot" AND "product"*');
  assert.equal(ftsQuery('vectors'), '"vectors"*');
});

test('FTS5 syntax in the input is defused, not escaped', () => {
  assert.equal(ftsQuery('C++'), '"c"');
  assert.equal(ftsQuery('what?'), '"what"*');
  assert.equal(ftsQuery('"unclosed'), '"unclosed"*');
  assert.equal(ftsQuery('foo:'), '"foo"*');
  assert.equal(ftsQuery('a OR b'), '"a" AND "or" AND "b"');
});

test('input with nothing searchable in it is no query at all', () => {
  for (const raw of ['', '   ', '!!!', '"', '-', '()']) {
    assert.equal(ftsQuery(raw), undefined, JSON.stringify(raw));
  }
});

test('non-Latin scripts and digits are searchable', () => {
  assert.equal(ftsQuery('θ 90'), '"θ" AND "90"*');
  assert.equal(ftsQuery('θ'), '"θ"', 'one character is exact, not a prefix');
  assert.equal(ftsQuery('مثلث'), '"مثلث"*');
});

test('a one-character query does not prefix-match the whole corpus', () => {
  assert.equal(ftsQuery('c'), '"c"');
  assert.equal(ftsQuery('dot c'), '"dot" AND "c"');
  assert.equal(ftsQuery('c dot'), '"c" AND "dot"*');
});
