// Structured results of the four lookups (search, read rules, look up a term, browse), shared by
// the MCP tools (rendered to Markdown in format.ts) and the REST API (returned as JSON).
// The zod schemas double as the OpenAPI response schemas.

import * as z from 'zod/v4';
import type { RulebookLibrary } from '../library.ts';
import { groupBySection, subtree } from '../markdown.ts';
import type { FaqEntry, Rule } from '../types.ts';

const SNIPPET_CHARS = 700;

export const RuleRefSchema = z.object({ id: z.string(), title: z.string() });

const RuleTextSchema = RuleRefSchema.extend({ text: z.string() });

export const FaqSchema = z.object({
  id: z.string().describe('FAQ id, e.g. FAQ-4'),
  question: z.string(),
  answer: z.string(),
  rules: z.array(RuleRefSchema).describe('Rules this FAQ entry clarifies'),
});

const RuleSummarySchema = RuleTextSchema.extend({
  path: z.array(RuleRefSchema).describe('Parent rules, top-level section first'),
  subruleCount: z.number().int(),
  faq: z.array(z.string()).describe('Ids of FAQ entries citing this rule'),
});

export const RuleContextSchema = z.object({
  id: z.string().describe('Canonical rule id, e.g. 9.2.9.3.1'),
  lawId: z.string().describe('Same id as printed in the Law, e.g. 9.2.9.IIIa'),
  title: z.string(),
  path: z.array(RuleRefSchema).describe('Parent rules, top-level section first'),
  faction: z.string().optional().describe('Faction name if this is a faction rule'),
  context: z.array(RuleTextSchema).describe('Framing text of parent rules'),
  text: z.string().describe('Rule text (Markdown); empty for headings'),
  children: z.array(RuleRefSchema),
  subrules: z
    .array(RuleTextSchema.extend({ depth: z.number().int(), faq: z.array(z.string()) }))
    .describe('Full text of all descendant rules, in order (empty if subrules=false)'),
  faq: z.array(FaqSchema).describe('FAQ entries citing this rule, its parents or its sub-rules'),
  errata: z.array(z.object({ id: z.string(), text: z.string() })),
  refersTo: z.array(RuleRefSchema),
  referencedBy: z.array(RuleRefSchema),
});

export const SearchSchema = z.object({
  query: z.string(),
  results: z.array(
    z.discriminatedUnion('type', [
      RuleSummarySchema.extend({
        type: z.literal('rule'),
        truncated: z.boolean().describe('Text was shortened; read the rule in full'),
      }),
      FaqSchema.extend({ type: z.literal('faq') }),
    ]),
  ),
  suggestions: z.array(z.string()).describe('Related game terms when nothing matched'),
});

export const KeywordSchema = z.object({
  term: z.string(),
  sources: z.array(z.string()).describe('Why this is a keyword: glossary, defined, heading, faction, item'),
  definedBy: z.array(RuleTextSchema.extend({ path: z.array(RuleRefSchema) })),
  usedIn: z.array(z.object({ section: RuleRefSchema, rules: z.array(z.string()) })),
  usedInCount: z.number().int(),
  faq: z.array(z.object({ id: z.string(), question: z.string() })),
});

export const TocSchema = z.object({
  section: RuleRefSchema.nullable().describe('The outlined section, or null for the list of all sections'),
  entries: z.array(
    RuleRefSchema.extend({
      depth: z.number().int(),
      faction: z.object({ key: z.string(), name: z.string(), aliases: z.array(z.string()) }).optional(),
    }),
  ),
});

export type RuleContextView = z.infer<typeof RuleContextSchema>;
export type SearchView = z.infer<typeof SearchSchema>;
export type KeywordView = z.infer<typeof KeywordSchema>;
export type TocView = z.infer<typeof TocSchema>;

const ref = (rule: Rule) => ({ id: rule.id, title: rule.title });

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 40))} …`;
}

export function faqView(lib: RulebookLibrary, f: FaqEntry): z.infer<typeof FaqSchema> {
  return { id: f.id, question: f.question, answer: f.answer, rules: f.rules.map((id) => ref(lib.book.rules[id]!)) };
}

/** Everything needed to rule on one rule: context, text, sub-rules, FAQ, errata, cross-refs. */
export function ruleContextView(lib: RulebookLibrary, rule: Rule, includeSubrules: boolean): RuleContextView {
  const { book } = lib;
  const ids = includeSubrules ? subtree(book, rule.id) : [rule.id];
  // FAQ citing this rule, its ancestors (general clarifications apply) or its sub-rules.
  const faqIds = new Set([...rule.breadcrumb.map((b) => b.id), ...ids].flatMap((id) => book.rules[id]!.faq));
  const errataIds = new Set(ids.flatMap((id) => book.rules[id]!.errata));

  return {
    id: rule.id,
    lawId: rule.lawId,
    title: rule.title,
    path: rule.breadcrumb,
    faction: rule.faction ? book.factions[rule.faction]?.name ?? rule.faction : undefined,
    // Parent rules often carry framing text ("Your Birdsong has two steps in the following order").
    context: rule.breadcrumb
      .map((b) => book.rules[b.id]!)
      .filter((r) => r.text)
      .map((r) => ({ ...ref(r), text: r.text })),
    text: rule.text,
    children: rule.children.map((id) => ref(book.rules[id]!)),
    subrules: ids.slice(1).map((id) => {
      const r = book.rules[id]!;
      return { ...ref(r), text: r.text, depth: r.depth, faq: r.faq };
    }),
    faq: book.faq.filter((f) => faqIds.has(f.id)).map((f) => faqView(lib, f)),
    errata: book.errata.filter((e) => errataIds.has(e.id)).map((e) => ({ id: e.id, text: e.text })),
    refersTo: rule.refs.map((id) => ref(book.rules[id]!)),
    referencedBy: rule.refBy.map((id) => ref(book.rules[id]!)),
  };
}

export function searchView(lib: RulebookLibrary, query: string, opts: { faction?: string; limit?: number }): SearchView {
  const hits = lib.search(query, opts);
  return {
    query,
    results: hits.map((hit) => {
      if (hit.kind === 'faq') return { type: 'faq' as const, ...faqView(lib, hit.faq) };
      const r = hit.rule;
      return {
        type: 'rule' as const,
        ...ref(r),
        path: r.breadcrumb,
        text: truncate(r.text, SNIPPET_CHARS),
        truncated: r.text.length > SNIPPET_CHARS,
        subruleCount: r.children.length,
        faq: r.faq,
      };
    }),
    suggestions: hits.length ? [] : lib.suggestKeywords(query).map((k) => k.term),
  };
}

/** Undefined if the term is not in the keyword index. */
export function keywordView(lib: RulebookLibrary, term: string): KeywordView | undefined {
  const entry = lib.findKeyword(term);
  if (!entry) return undefined;
  const { book } = lib;
  return {
    term: entry.term,
    sources: entry.sources,
    definedBy: entry.main.map((id) => {
      const r = book.rules[id]!;
      return { ...ref(r), path: r.breadcrumb, text: r.text };
    }),
    usedIn: groupBySection(book, entry.mentions).map(([section, rules]) => ({
      section: ref(book.rules[section]!),
      rules,
    })),
    usedInCount: entry.mentions.length,
    faq: entry.faq.map((id) => ({ id, question: book.faq.find((f) => f.id === id)!.question })),
  };
}

export function tocView(lib: RulebookLibrary, section?: Rule): TocView {
  const { book } = lib;
  if (!section) {
    return {
      section: null,
      entries: book.sections.map((id) => {
        const faction = Object.values(book.factions).find((f) => f.sectionId === id);
        return {
          ...ref(book.rules[id]!),
          depth: 1,
          faction: faction ? { key: faction.key, name: faction.name, aliases: faction.aliases } : undefined,
        };
      }),
    };
  }
  return {
    section: ref(section),
    entries: subtree(book, section.id).map((id) => {
      const r = book.rules[id]!;
      return { ...ref(r), depth: r.depth };
    }),
  };
}
