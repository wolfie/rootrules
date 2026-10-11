// Reverse keyword index: which rules (and FAQ entries) use each game term.
//
// Keywords are not every word, but terms the Law itself treats as terms:
//   glossary   - Glossary entries (appendix G)
//   defined    - words set in **bold** where the Law defines them
//   heading    - short concept headings, e.g. "Ambush", "Lone Wanderer"
//   faction    - faction names
//   item       - item names (sword, boot, ...)
// Matching is case-insensitive and tolerates plural/verb endings (remove -> removed, removing).

import type { KeywordEntry, KeywordSource, Rulebook } from './types.ts';

/** Headings that structure the document rather than name a game concept. */
const HEADING_STOPLIST = new Set([
  'overview', 'faction rules and abilities', 'faction setup', 'other', 'booklets',
  'cardboard pieces', 'wooden pieces', 'starting items', 'cost', 'setup', 'effect',
  'setup modifications', 'cards', 'pieces',
]);

/** Bold text that isn't a term (formatting, placeholders). */
const DEFINED_STOPLIST = new Set(['[faction name] piece']);

const ITEMS = ['boot', 'sword', 'crossbow', 'hammer', 'torch', 'tea', 'coin', 'sack'];

/**
 * Phrases blanked out before matching a keyword, where the word is used in its everyday
 * sense. "Rule" (to rule a clearing) collides with "this rule", "faction rules", etc.
 */
const MENTION_EXCLUDES: Record<string, RegExp> = {
  rule: /\b(?:this|that|the|these|those|golden|faction|general|hireling|any|following|other|its|their|normal|setup|special|both)\s+rules?\b|\brules?\s+(?:conflicts?|text)\b|\bfor rule\b|\/rules?\b/gi,
};

// Upper bound on heading length (in words) to count as a concept rather than a description.
const MAX_HEADING_WORDS = 4;

const PRIORITY: KeywordSource[] = ['glossary', 'heading', 'faction', 'item', 'defined'];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function singular(word: string): string {
  if (/^.{2,}[^aeiou]ies$/.test(word)) return word.slice(0, -3) + 'y';
  if (word.endsWith('ies')) return word.slice(0, -1); // ties -> tie
  if (/(?:ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (/[^su]s$/.test(word)) return word.slice(0, -1);
  return word;
}

/** Normalized lookup key: lowercase, single spaces, last word singular. */
export function keyOf(term: string): string {
  const words = term.toLowerCase().replace(/[.:]+$/, '').split(/\s+/).filter(Boolean);
  if (words.length) words[words.length - 1] = singular(words.at(-1)!);
  return words.join(' ');
}

function inflections(word: string): string[] {
  const forms = new Set([word, `${word}s`, `${word}es`, `${word}d`, `${word}ed`, `${word}ing`]);
  if (word.endsWith('e')) forms.add(`${word.slice(0, -1)}ing`);
  if (/[^aeiou]y$/.test(word)) {
    forms.add(`${word.slice(0, -1)}ies`);
    forms.add(`${word.slice(0, -1)}ied`);
  }
  // Consonant doubling for short verbs: swap -> swapped, map -> mapping.
  if (/(?:^|[^aeiou])[aeiou][bdgmnprt]$/.test(word)) {
    forms.add(`${word}${word.at(-1)}ed`);
    forms.add(`${word}${word.at(-1)}ing`);
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

function matcher(key: string): RegExp {
  const words = key.split(' ');
  const last = words.pop()!;
  const prefix = words.map((w) => `${escapeRe(w)}\\s+`).join('');
  return new RegExp(`(?<![\\w-])${prefix}(?:${inflections(last).map(escapeRe).join('|')})(?![\\w-])`, 'i');
}

/** Text a rule is searched by: title + body, without cross-reference labels or markup. */
function searchable(s: string): string {
  return s
    .replace(/§[\w.]+ \[[^\]]*\]/g, ' ')
    .replace(/[*_]/g, '')
    .replace(/\s+/g, ' ');
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function buildKeywordIndex(book: Omit<Rulebook, 'keywords'>): KeywordEntry[] {
  const entries = new Map<string, KeywordEntry & { rank: number }>();

  const add = (term: string, source: KeywordSource, mainRule?: string) => {
    const key = keyOf(term);
    if (!key || /[^\p{L}\p{N}' -]/u.test(key)) return;
    // Bold terms appear mid-sentence ("**trade posts**"), so show their singular form;
    // titles and names keep their own spelling.
    const display = capitalize(source === 'defined' ? key : term.replace(/[.:]+$/, '').trim());
    const rank = PRIORITY.indexOf(source);
    let entry = entries.get(key);
    if (!entry) {
      entry = { term: display, key, sources: [], main: [], mentions: [], faq: [], rank };
      entries.set(key, entry);
    } else if (rank < entry.rank) {
      entry.term = display;
      entry.rank = rank;
    }
    if (!entry.sources.includes(source)) entry.sources.push(source);
    if (mainRule && !entry.main.includes(mainRule)) entry.main.push(mainRule);
  };

  for (const id of book.order) {
    const rule = book.rules[id]!;
    if (rule.breadcrumb[0]?.id === 'G' && rule.depth === 2) add(rule.title, 'glossary', id);

    for (const m of rule.text.matchAll(/\*\*([^*]+)\*\*/g)) {
      if (!DEFINED_STOPLIST.has(keyOf(m[1]!))) add(m[1]!, 'defined', id);
    }

    if (rule.depth >= 2) {
      const title = rule.title.replace(/\s*\([^)]*\)$/, '');
      const words = title.split(/\s+/);
      if (
        words.length <= MAX_HEADING_WORDS &&
        !/^step\s+\d/i.test(title) &&
        !/\d/.test(title) &&
        !HEADING_STOPLIST.has(title.toLowerCase())
      ) {
        add(title, 'heading', id);
      }
    }
  }
  for (const faction of Object.values(book.factions)) add(faction.name, 'faction', faction.sectionId);
  for (const item of ITEMS) add(item, 'item');

  const ruleTexts = book.order.map((id) => {
    const rule = book.rules[id]!;
    return [id, searchable(`${rule.title}. ${rule.text}`)] as const;
  });
  const faqTexts = book.faq.map((e) => [e.id, searchable(`${e.question} ${e.answer}`)] as const);

  for (const entry of entries.values()) {
    const re = matcher(entry.key);
    const exclude = MENTION_EXCLUDES[entry.key];
    const hit = (text: string) => re.test(exclude ? text.replace(exclude, ' ') : text);
    const main = new Set(entry.main);
    entry.mentions = ruleTexts.filter(([id, text]) => !main.has(id) && hit(text)).map(([id]) => id);
    entry.faq = faqTexts.filter(([, text]) => hit(text)).map(([id]) => id);
    // Main entries in document order.
    entry.main.sort((a, b) => book.order.indexOf(a) - book.order.indexOf(b));
  }

  return [...entries.values()]
    .filter((e) => e.main.length + e.mentions.length + e.faq.length > 0)
    .map(({ rank: _rank, ...entry }) => entry)
    .sort((a, b) => a.key.localeCompare(b.key));
}
