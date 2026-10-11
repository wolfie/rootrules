import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromRoman, lawLabel, normalizeRuleRef, toRoman } from '../src/ids.ts';
import { renderFull } from '../src/markdown.ts';
import { buildRulebook } from '../src/rulebook.ts';
import { loadBuildInput, snapshotDir } from '../src/snapshot.ts';

const appendices = new Map([['21', 'G'], ['22', 'H']]);

test('roman numerals round-trip', () => {
  for (let n = 1; n <= 40; n++) assert.equal(fromRoman(toRoman(n)), n);
  assert.equal(fromRoman('IIII'), undefined);
});

test('lawLabel uses roman numeral + letter for depth 4 and 5', () => {
  assert.equal(lawLabel(['9', '2', '9', '3', '1']), '9.2.9.IIIa');
  assert.equal(lawLabel(['G', '24']), 'G.24');
});

test('normalizeRuleRef accepts every spelling of a rule id', () => {
  const cases: [string, string][] = [
    ['9.2.9.3.1', '9.2.9.3.1'],
    ['9.2.9.IIIa', '9.2.9.3.1'],
    ['9.2.9.III.a', '9.2.9.3.1'],
    ['9.2.9.IV', '9.2.9.4'],
    ['21.24', 'G.24'],
    ['g.24', 'G.24'],
    ['22.', 'H'],
    ['§4.1.1', '4.1.1'],
    ['rule 4.1.1.', '4.1.1'],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeRuleRef(input, appendices), expected, input);
  assert.equal(normalizeRuleRef('hello', appendices), undefined);
});

const book = buildRulebook(await loadBuildInput(snapshotDir('root', 'en-US')));

test('section numbering matches upstream, with appendix letters', () => {
  assert.equal(book.rules['1']!.title, 'Golden Rules');
  assert.equal(book.rules['G']!.title, 'Glossary');
  assert.equal(book.rules['G']!.numericId, '21');
  assert.equal(book.rules['9.2.9.3.1']!.title, 'Infamy');
  assert.equal(book.rules['9.2.9.3.1']!.lawId, '9.2.9.IIIa');
  assert.deepEqual(book.rules['9.2.9.3.1']!.breadcrumb.map((r) => r.id), ['9', '9.2', '9.2.9', '9.2.9.3']);
});

test('every rule cross-reference resolves', () => {
  const unresolved = book.meta.warnings.filter((w) => w.startsWith('rule '));
  assert.deepEqual(unresolved, []);
});

test('no raw upstream markers remain in rendered text', () => {
  assert.doesNotMatch(renderFull(book), /`[a-z-]+:[^`]*`/);
});

test('cross-references are recorded both ways', () => {
  const crafting = book.rules['9.2.1']!;
  assert.ok(crafting.refs.includes('4.1.1'));
  assert.ok(book.rules['4.1.1']!.refBy.includes('9.2.1'));
  assert.match(crafting.text, /§4\.1\.1 \[/);
});

test('FAQ entries attach to the rules they cite', () => {
  const ambush = book.faq.find((e) => /multiple ambush/i.test(e.question))!;
  assert.deepEqual(ambush.rules, ['4.3.1']);
  assert.ok(book.rules['4.3.1']!.faq.includes(ambush.id));
});

test('keyword index merges plural/singular forms and links main entries', () => {
  const keyword = (key: string) => book.keywords.find((e) => e.key === key)!;
  assert.equal(book.keywords.filter((e) => e.key === 'item').length, 1);
  assert.ok(keyword('item').sources.includes('glossary'));
  assert.ok(keyword('ambush card').faq.length > 0);
  assert.ok(keyword('lone wanderer').main.includes('9.2.2'));
});

test('keyword matching covers inflections but skips everyday uses', () => {
  const keyword = (key: string) => book.keywords.find((e) => e.key === key)!;
  // 3.3.1.1: "...if you rule three clearings..." is the game term.
  assert.ok(keyword('rule').mentions.includes('3.3.1.1'));
  // "This rule overrides..." in 9.2.9.2.4 is not.
  assert.ok(!keyword('rule').mentions.includes('9.2.9.2.4'));
  // "removed" counts as a use of "Remove".
  const removed = book.order.find((id) => /\bremoved\b/.test(book.rules[id]!.text) && !/\bremove\b/i.test(book.rules[id]!.text))!;
  assert.ok(keyword('remove').mentions.includes(removed), removed);
});

test('factions are discovered from section icons', () => {
  assert.equal(book.factions['vagabond']!.sectionId, '9');
  assert.equal(book.rules['9.2.1']!.faction, 'vagabond');
  assert.ok(book.factions['marquise']!.aliases.includes('cats'));
});
