/** Where a snapshot of the upstream rules came from. Written by `scripts/fetch.ts`. */
export interface SourceInfo {
  repo: string;
  commit: string;
  commitDate: string;
  fetchedAt: string;
  game: string;
  locale: string;
  printing: string;
  /** sha256 of each downloaded file, keyed by file name. */
  files: Record<string, string>;
}

export interface RuleRef {
  id: string;
  title: string;
}

export interface Rule {
  /** Canonical id as shown in the Law, e.g. "9.2.9.3.1" or "G.24" for appendices. */
  id: string;
  /** Purely numeric form used by upstream cross-references, e.g. "21.24" for "G.24". */
  numericId: string;
  /** Printed-Law style label with roman numerals at depth 4, e.g. "9.2.9.IIIa". */
  lawId: string;
  /** Plain-text title without markup or trailing period. */
  title: string;
  /** 1 = top-level section. */
  depth: number;
  parent: string | null;
  children: string[];
  /** Ancestors from the top-level section down to the parent. */
  breadcrumb: RuleRef[];
  /** Faction key (e.g. "vagabond") when the rule lives in a faction section. */
  faction?: string;
  /** Rule text as Markdown, with inline markers resolved to plain text. Empty for pure headings. */
  text: string;
  /** Rules this rule cross-references. */
  refs: string[];
  /** Rules that cross-reference this rule. */
  refBy: string[];
  /** FAQ entries that cite this rule. */
  faq: string[];
  /** Errata entries that cite this rule. */
  errata: string[];
}

export interface FaqEntry {
  id: string;
  question: string;
  answer: string;
  /** Resolved canonical rule ids. */
  rules: string[];
}

export interface ErrataEntry {
  id: string;
  text: string;
  rules: string[];
}

export interface Faction {
  key: string;
  name: string;
  sectionId: string;
  aliases: string[];
}

export type KeywordSource = 'glossary' | 'defined' | 'heading' | 'faction' | 'item';

export interface KeywordEntry {
  /** Display form, e.g. "Enemy Piece". */
  term: string;
  /** Normalized lowercase key, e.g. "enemy piece". */
  key: string;
  /** Why this is a keyword. */
  sources: KeywordSource[];
  /** Rules that define the term or are headed by it. */
  main: string[];
  /** Other rules that use the term, in document order. */
  mentions: string[];
  /** FAQ entries that use the term. */
  faq: string[];
}

export interface Rulebook {
  meta: {
    title: string;
    source: SourceInfo;
    /** Human-readable "last updated" string from upstream app config, if present. */
    upstreamUpdated?: string;
    builtAt: string;
    warnings: string[];
  };
  /** Every rule id in document order. */
  order: string[];
  /** Top-level section ids in order. */
  sections: string[];
  rules: Record<string, Rule>;
  faq: FaqEntry[];
  errata: ErrataEntry[];
  factions: Record<string, Faction>;
  /** Reverse keyword index, sorted by key. */
  keywords: KeywordEntry[];
}
