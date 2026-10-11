// Query layer over a built Rulebook: id resolution, faction/keyword lookup and ranked search.
// Used by the MCP server; independent of any transport.

import MiniSearch from 'minisearch';
import { normalizeRuleRef } from './ids.ts';
import { keyOf } from './keywords.ts';
import type { Faction, FaqEntry, KeywordEntry, Rule, Rulebook } from './types.ts';

export type SearchHit =
  | { kind: 'rule'; rule: Rule; score: number }
  | { kind: 'faq'; faq: FaqEntry; score: number };

interface SearchDoc {
  id: string;
  kind: 'rule' | 'faq';
  ref: string;
  title: string;
  text: string;
  path: string;
  factions: string[];
}

const STOPWORDS = new Set(
  ('a an the and or of to in on at for with by from is are be been it its this that these those as if ' +
    'you your their they them he his she her i my me we our us can may must do does did any each ' +
    'one than then into out when which who what how so s there have has had will would should').split(' '),
);

/** Crude stemmer applied identically to documents and queries: removed/removing/remove -> remov. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (/(?:ss|x|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

function processTerm(term: string): string | null {
  const t = term.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (!t || STOPWORDS.has(t)) return null;
  return stem(t);
}

const stemKey = (s: string) =>
  s.toLowerCase().split(/\s+/).filter(Boolean).map((w) => stem(w.replace(/[^\p{L}\p{N}]/gu, ''))).join(' ');

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Something that looks like a rule id: "4.3.1", "§G.24", "9.2.9.IIIa". Requires a dot.
const RULE_ID = /(?:§\s*)?\b(?:\d{1,2}|[A-Z])(?:\.(?:\d{1,2}|[IVX]{1,4}[a-z]?))+\b/g;

export class RulebookLibrary {
  readonly book: Rulebook;
  private readonly appendixByNumber: Map<string, string>;
  private readonly index: MiniSearch<SearchDoc>;
  private readonly keywordsByKey: Map<string, KeywordEntry>;
  private readonly keywordsByStem: Map<string, KeywordEntry>;

  constructor(book: Rulebook) {
    this.book = book;
    this.appendixByNumber = new Map(
      book.sections.filter((id) => /^[A-Z]$/.test(id)).map((id) => [book.rules[id]!.numericId, id]),
    );
    this.keywordsByKey = new Map(book.keywords.map((k) => [k.key, k]));
    // On stem collisions keep the more central term (glossary first, then most references).
    const weight = (k: KeywordEntry) => (k.sources.includes('glossary') ? 1e6 : 0) + k.main.length + k.mentions.length;
    this.keywordsByStem = new Map();
    for (const k of book.keywords) {
      const key = stemKey(k.key);
      const existing = this.keywordsByStem.get(key);
      if (!existing || weight(k) > weight(existing)) this.keywordsByStem.set(key, k);
    }

    this.index = new MiniSearch<SearchDoc>({
      fields: ['title', 'text', 'path'],
      storeFields: ['kind', 'ref', 'factions'],
      processTerm,
    });
    this.index.addAll([
      ...book.order.map((id): SearchDoc => {
        const rule = book.rules[id]!;
        return {
          id: `rule:${id}`,
          kind: 'rule',
          ref: id,
          title: rule.title,
          text: rule.text,
          path: rule.breadcrumb.map((b) => b.title).join(' '),
          factions: rule.faction ? [rule.faction] : [],
        };
      }),
      ...book.faq.map((faq): SearchDoc => ({
        id: `faq:${faq.id}`,
        kind: 'faq',
        ref: faq.id,
        title: faq.question,
        text: faq.answer,
        path: '',
        factions: [...new Set(faq.rules.map((id) => book.rules[id]!.faction).filter((f): f is string => !!f))],
      })),
    ]);
  }

  /** Resolve any spelling of a rule id ("9.2.9.IIIa", "21.24", "§G.24") to a rule. */
  resolve(ref: string): Rule | undefined {
    const id = normalizeRuleRef(ref, this.appendixByNumber);
    return id ? this.book.rules[id] : undefined;
  }

  /** Resolve a rule id, or a section/faction by name or nickname ("Glossary", "cats"). */
  resolveSection(ref: string): Rule | undefined {
    const rule = this.resolve(ref);
    if (rule) return rule;
    const faction = this.findFaction(ref);
    if (faction) return this.book.rules[faction.sectionId];
    const name = ref.trim().toLowerCase();
    const sectionId = this.book.sections.find((id) => this.book.rules[id]!.title.toLowerCase() === name);
    return sectionId ? this.book.rules[sectionId] : undefined;
  }

  findFaction(name: string): Faction | undefined {
    const n = name.trim().toLowerCase();
    return Object.values(this.book.factions).find(
      (f) => f.key === n || f.name.toLowerCase() === n || f.aliases.includes(n),
    );
  }

  /** Find a keyword by name, tolerating inflections ("removed" -> Remove). */
  findKeyword(term: string): KeywordEntry | undefined {
    return this.keywordsByKey.get(keyOf(term.trim())) ?? this.keywordsByStem.get(stemKey(term));
  }

  /** Keywords whose name overlaps the term, for "did you mean" suggestions. */
  suggestKeywords(term: string, limit = 8): KeywordEntry[] {
    const stems = term.toLowerCase().split(/\s+/).map(processTerm).filter((t): t is string => !!t);
    if (!stems.length) return [];
    return this.book.keywords
      .map((k) => {
        const kStems = k.key.split(' ').map(processTerm).filter(Boolean);
        const overlap = stems.filter((s) => kStems.some((ks) => ks === s || ks!.startsWith(s) || s.startsWith(ks!))).length;
        return { k, overlap, size: k.main.length + k.mentions.length };
      })
      .filter((x) => x.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap || b.size - a.size)
      .slice(0, limit)
      .map((x) => x.k);
  }

  search(query: string, opts: { faction?: string; limit?: number } = {}): SearchHit[] {
    const limit = opts.limit ?? 8;
    const book = this.book;

    // Explicit rule ids in the query are returned first, as-is.
    const direct: Rule[] = [];
    const words = query.replace(RULE_ID, (id) => {
      const rule = this.resolve(id);
      if (!rule) return id;
      if (!direct.includes(rule)) direct.push(rule);
      return ' ';
    });
    if (!words.trim()) return direct.map((rule) => ({ kind: 'rule', rule, score: Infinity }));

    // Faction nicknames ("cats") are expanded to the faction name and favour that faction.
    const lower = words.toLowerCase();
    const mentioned = Object.values(book.factions).filter((f) =>
      f.aliases.some((a) => new RegExp(`\\b${escapeRe(a)}\\b`).test(lower)),
    );
    const expanded = [words, ...mentioned.map((f) => f.name)].join(' ');

    // Rules that define a game term named in the query get a boost.
    const defining = new Set<string>();
    for (const k of book.keywords) {
      if (new RegExp(`\\b${escapeRe(k.key)}s?\\b`).test(lower)) k.main.forEach((id) => defining.add(id));
    }

    const factionFilter = opts.faction ? this.findFaction(opts.faction)?.key ?? opts.faction.toLowerCase() : undefined;
    const mentionedKeys = new Set(mentioned.map((f) => f.key));

    const results = this.index.search(expanded, {
      boost: { title: 3, text: 1, path: 0.5 },
      prefix: (term) => term.length > 4,
      fuzzy: (term) => (term.length > 5 ? 0.2 : false),
      filter: factionFilter ? (r) => (r.factions as string[]).includes(factionFilter) : undefined,
      boostDocument: (id: string, _term, stored) => {
        let boost = 1;
        if (stored?.kind === 'rule' && defining.has(stored.ref as string)) boost *= 2;
        if ((stored?.factions as string[] | undefined)?.some((f) => mentionedKeys.has(f))) boost *= 1.5;
        if (id.startsWith('faq:')) boost *= 1.2;
        return boost;
      },
    });

    const hits: SearchHit[] = direct.map((rule) => ({ kind: 'rule', rule, score: Infinity }));
    for (const r of results) {
      if (hits.length >= limit + direct.length) break;
      if (r.kind === 'rule') {
        const rule = book.rules[r.ref as string]!;
        if (!direct.includes(rule)) hits.push({ kind: 'rule', rule, score: r.score });
      } else {
        hits.push({ kind: 'faq', faq: book.faq.find((f) => f.id === r.ref)!, score: r.score });
      }
    }
    return hits;
  }
}
