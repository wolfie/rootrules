import { citation } from './rulebook.ts';
import type { ErrataEntry, FaqEntry, KeywordEntry, Rule, Rulebook } from './types.ts';

export const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Rough token estimate (~4 chars/token for English prose). */
export const estimateTokens = (s: string) => Math.round(s.length / 4);

export function sectionFileName(book: Rulebook, sectionId: string): string {
  const rule = book.rules[sectionId]!;
  return `${rule.numericId.padStart(2, '0')}-${slugify(rule.title)}.md`;
}

export function conventions(book: Rulebook): string {
  const appendices = book.sections
    .filter((id) => /^[A-Z]$/.test(id))
    .map((id) => `${id} = ${book.rules[id]!.title}`)
    .join(', ');
  return [
    '- Every rule has an id. Sections are numbered; appendices use letters ' +
      `(${appendices}). Sub-rules add dotted numbers, e.g. 9.2.9.3.1. ` +
      'The printed Law writes the 4th and 5th levels as roman numeral + letter (9.2.9.IIIa); both forms name the same rule.',
    '- Cross-references are written as §<id> [<title>].',
    '- "(<Faction> exception: §<id> [...])" marks a faction rule that modifies the rule it appears in.',
    '- Text in _(italic parentheses)_ is clarification or examples, not additional rules.',
    '- FAQ-n entries are official clarifications. Rules list the FAQ entries that cite them.',
    '- Precedence is set by the Golden Rules (§1): if a card conflicts with the Law, follow the card.',
    '- When answering a rules question, cite the rule ids (and FAQ ids) the answer depends on.',
  ].join('\n');
}

function provenance(book: Rulebook): string {
  const s = book.meta.source;
  const updated = book.meta.upstreamUpdated ? `, upstream updated ${book.meta.upstreamUpdated}` : '';
  return `Source: https://github.com/${s.repo} @ ${s.commit.slice(0, 7)} (${s.game}/${s.locale}/${s.printing}${updated})`;
}

export function renderRule(book: Rulebook, rule: Rule): string {
  let head: string;
  let body = rule.text;
  if (rule.depth === 1) {
    head = `## ${rule.id}. ${rule.title}`;
  } else if (rule.depth === 2) {
    head = `### ${rule.id} ${rule.title}`;
  } else {
    const title = /[.?!:]$/.test(rule.title) ? rule.title : `${rule.title}.`;
    // Bold run-in heading: keeps deep rules compact and on one line with their text.
    const runIn = `**${rule.id} ${title}**`;
    const [first = '', ...rest] = body.split('\n\n');
    head = first ? `${runIn} ${first}` : runIn;
    body = rest.join('\n\n');
  }

  const notes = [
    rule.faq.length ? `Clarified by ${rule.faq.join(', ')}.` : '',
    rule.errata.length ? `Errata: ${rule.errata.join(', ')}.` : '',
  ].filter(Boolean);

  return [head, body, notes.length ? `_${notes.join(' ')}_` : '']
    .filter(Boolean)
    .join('\n\n');
}

export function renderFaqEntry(book: Rulebook, entry: FaqEntry): string {
  const cites = entry.rules.map((id) => citation(book.rules[id]!)).join(', ');
  return [
    `### ${entry.id}`,
    `**Q:** ${entry.question}`,
    `**A:** ${entry.answer}`,
    cites ? `_Cites: ${cites}_` : '',
  ].filter(Boolean).join('\n\n');
}

export function renderErrataEntry(book: Rulebook, entry: ErrataEntry): string {
  const cites = entry.rules.map((id) => citation(book.rules[id]!)).join(', ');
  return [`### ${entry.id}`, entry.text, cites ? `_Applies to: ${cites}_` : '']
    .filter(Boolean).join('\n\n');
}

/** Ids of the rule and all its descendants, in document order. */
export function subtree(book: Rulebook, id: string): string[] {
  const rule = book.rules[id]!;
  return [id, ...rule.children.flatMap((child) => subtree(book, child))];
}

function renderRules(book: Rulebook, ids: string[]): string {
  return ids.map((id) => renderRule(book, book.rules[id]!)).join('\n\n');
}

export function renderSection(book: Rulebook, sectionId: string): string {
  const ids = subtree(book, sectionId);
  const inSection = new Set(ids);
  const faq = book.faq.filter((e) => e.rules.some((r) => inSection.has(r)));
  const errata = book.errata.filter((e) => e.rules.some((r) => inSection.has(r)));
  const title = book.rules[sectionId]!.title;

  return [
    `# The Law of Root — ${sectionId}. ${title}`,
    provenance(book),
    conventions(book),
    renderRules(book, ids),
    errata.length ? `## Errata for this section\n\n${errata.map((e) => renderErrataEntry(book, e)).join('\n\n')}` : '',
    faq.length ? `## FAQ for this section\n\n${faq.map((e) => renderFaqEntry(book, e)).join('\n\n')}` : '',
  ].filter(Boolean).join('\n\n') + '\n';
}

export function renderFaq(book: Rulebook): string {
  return [
    '# The Law of Root — FAQ',
    provenance(book),
    book.faq.map((e) => renderFaqEntry(book, e)).join('\n\n'),
  ].join('\n\n') + '\n';
}

export function renderFull(book: Rulebook): string {
  return [
    '# The Law of Root',
    provenance(book),
    '## How to read this document',
    conventions(book),
    renderRules(book, book.order),
    book.errata.length ? `## Errata\n\n${book.errata.map((e) => renderErrataEntry(book, e)).join('\n\n')}` : '',
    book.faq.length ? `## FAQ\n\n${book.faq.map((e) => renderFaqEntry(book, e)).join('\n\n')}` : '',
  ].filter(Boolean).join('\n\n') + '\n';
}

const sectionOf = (rule: Rule) => (rule.depth === 1 ? rule.id : rule.breadcrumb[0]!.id);

/** Index letter a keyword is filed under: A-Z, or "#" for anything else. */
export const keywordLetter = (entry: KeywordEntry) =>
  /^[a-z]/i.test(entry.term) ? entry.term[0]!.toUpperCase() : '#';

export const keywordFileName = (letter: string) => (letter === '#' ? 'other.md' : `${letter.toLowerCase()}.md`);

/** Keyword entries grouped by index letter, letters in alphabetical order. */
export function keywordsByLetter(book: Rulebook): Map<string, KeywordEntry[]> {
  const groups = new Map<string, KeywordEntry[]>();
  for (const entry of book.keywords) {
    const letter = keywordLetter(entry);
    groups.set(letter, [...(groups.get(letter) ?? []), entry]);
  }
  return new Map([...groups].sort(([a], [b]) => a.localeCompare(b)));
}

/** Rule ids grouped by top-level section id, in first-seen order. */
export function groupBySection(book: Rulebook, ids: string[]): [string, string[]][] {
  const bySection = new Map<string, string[]>();
  for (const id of ids) {
    const section = sectionOf(book.rules[id]!);
    bySection.set(section, [...(bySection.get(section) ?? []), id]);
  }
  return [...bySection];
}

/** Rule ids as a list grouped by top-level section: "- 9. Vagabond: 9.2.1, 9.2.3". */
export function idsBySection(book: Rulebook, ids: string[]): string[] {
  return groupBySection(book, ids).map(
    ([section, sectionIds]) => `- ${section}. ${book.rules[section]!.title}: ${sectionIds.join(', ')}`,
  );
}

export function renderKeywordEntry(book: Rulebook, entry: KeywordEntry): string {
  const usedIn = idsBySection(book, entry.mentions);

  return [
    `## ${entry.term}`,
    entry.main.length ? `**Main:** ${entry.main.map((id) => citation(book.rules[id]!)).join(', ')}` : '',
    usedIn.length ? `**Used in:**\n${usedIn.join('\n')}` : '',
    entry.faq.length ? `**FAQ:** ${entry.faq.join(', ')}` : '',
  ].filter(Boolean).join('\n\n');
}

const KEYWORD_HOWTO =
  'Each keyword lists its **Main** entries (where the Law defines it or a rule is headed by it), ' +
  'then every other rule that uses it, grouped by top-level section, then FAQ entries that mention it. ' +
  'Look rules up by id in rules.md or sections/. Matching includes plural and verb forms (remove, removed, removing).';

export function renderKeywordLetter(book: Rulebook, letter: string, entries: KeywordEntry[]): string {
  return [
    `# The Law of Root — Keyword index: ${letter}`,
    provenance(book),
    KEYWORD_HOWTO,
    entries.map((e) => renderKeywordEntry(book, e)).join('\n\n'),
  ].join('\n\n') + '\n';
}

export function renderKeywordOverview(book: Rulebook): string {
  const letters = [...keywordsByLetter(book)].map(([letter, entries]) => {
    const file = keywordFileName(letter);
    const terms = entries.map((e) => `[${e.term}](${file}#${slugify(e.term)})`).join(' · ');
    return `## [${letter}](${file})\n\n${terms}`;
  });
  return [
    '# The Law of Root — Keyword index',
    provenance(book),
    KEYWORD_HOWTO,
    letters.join('\n\n'),
  ].join('\n\n') + '\n';
}

/** An index in the llms.txt format (https://llmstxt.org). `files` maps output path -> content. */
export function renderLlmsTxt(book: Rulebook, files: Record<string, string>): string {
  const tokens = (name: string) => `~${Math.round(estimateTokens(files[name] ?? '') / 1000)}k tokens`;
  const sectionLinks = book.sections.map((id) => {
    const file = `sections/${sectionFileName(book, id)}`;
    return `- [${id}. ${book.rules[id]!.title}](${file}): ${tokens(file)}`;
  });

  return [
    '# The Law of Root',
    '> The complete official rules reference for the board game Root (the "Law of Root") ' +
      'with the official FAQ, preprocessed for language models. Use it to answer and arbitrate rules questions, citing rule ids.',
    provenance(book),
    conventions(book),
    '## Complete text',
    `- [Rules, errata and FAQ in one file](rules.md): ${tokens('rules.md')}`,
    '## Sections',
    sectionLinks.join('\n'),
    '## Keyword index',
    `- [All keywords A–Z](keywords/index.md): ${book.keywords.length} game terms, each linking to the rules that define and use it`,
    '## Optional',
    `- [FAQ only](faq.md): ${tokens('faq.md')}`,
    '- [Structured data](rulebook.json): every rule with id, title, text, parent/children, cross-references and FAQ links',
  ].join('\n\n') + '\n';
}
