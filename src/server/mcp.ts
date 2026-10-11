import { readFileSync } from 'node:fs';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { RulebookLibrary } from '../library.ts';
import { renderFaq, renderFull, renderSection } from '../markdown.ts';
import { formatKeyword, formatRuleContext, formatSearchResults, formatToc } from './format.ts';
import { keywordView, ruleContextView, searchView, tocView } from './views.ts';

/** Returns the current rulebook; the store may swap it when the data is rebuilt. */
export type LibraryProvider = () => RulebookLibrary;

export const { version: SERVER_VERSION } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

export const INSTRUCTIONS = `Official rules reference for the board game Root: the Law of Root and the official FAQ (Leder Games).
Use these tools for every Root rules question. Do not answer rules questions from memory.

To rule on a question or game situation:
1. search_rules with the key terms (add the faction if one is involved).
2. get_rules on the relevant rule ids to read the exact text, sub-rules, FAQ, errata and cross-references.
   Follow cross-references and faction exceptions that could change the outcome.
3. lookup_term for defined game terms (e.g. "rule", "remove", "adjacent", "enemy") when the wording matters.

Precedence (Golden Rules §1.1): cards override the Law; faction and hireling rules override general rules; "cannot" is absolute.
Answer with a clear ruling and cite the rule ids (e.g. §4.3.1) and FAQ ids (e.g. FAQ-4) it rests on.
If the rules do not settle the question, say so instead of guessing.
Rule ids: numbered sections, lettered appendices (G = Glossary). The printed Law writes deep levels as roman numerals: 9.2.9.IIIa is the same rule as 9.2.9.3.1.`;

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const error = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function createRootRulesServer(getLibrary: LibraryProvider): McpServer {
  const lib = getLibrary();
  const { book } = lib;
  const server = new McpServer({ name: 'root-rules', title: 'Root Rules (Law of Root)', version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'search_rules',
    {
      title: 'Search the Law of Root',
      description:
        'Full-text search over all Root rules and the official FAQ. Returns the best-matching rules (id, path, text) and FAQ entries. ' +
        'Use it first to find which rules govern a question, then get_rules to read them in full. ' +
        'Rule ids in the query (e.g. "4.3.1") are looked up directly. Faction nicknames like "cats" or "birds" work.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Keywords or a natural-language question, e.g. "ambush card defender battle"'),
        faction: z
          .string()
          .optional()
          .describe('Only return rules of this faction, e.g. "vagabond", "Eyrie Dynasties", "cats"'),
        limit: z.number().int().min(1).max(25).optional().describe('Maximum results (default 8)'),
      }),
      annotations: readOnly,
    },
    async ({ query, faction, limit }) => {
      if (faction && !lib.findFaction(faction)) {
        const known = Object.values(book.factions).map((f) => `${f.key} (${f.name})`).join(', ');
        return error(`Unknown faction "${faction}". Known factions: ${known}`);
      }
      return text(formatSearchResults(searchView(lib, query, { faction, limit })));
    },
  );

  server.registerTool(
    'get_rules',
    {
      title: 'Read rules by id',
      description:
        'Read one or more rules in full by id, with everything needed to rule on them: the path of parent rules and their framing text, ' +
        'the rule text, all sub-rules, FAQ and errata that apply, and cross-references in both directions. ' +
        'Accepts ids like "4.3.1", "G.24", "9.2.9.IIIa" or a section such as "9" or "H".',
      inputSchema: z.object({
        ids: z.array(z.string()).min(1).max(20).describe('Rule ids, e.g. ["4.3.1", "G.24"]'),
        include_subrules: z
          .boolean()
          .optional()
          .describe('Include the full text of all sub-rules (default true). Set false for an outline of a large section.'),
      }),
      annotations: readOnly,
    },
    async ({ ids, include_subrules }) => {
      const found = [];
      const missing = [];
      for (const ref of ids) {
        const rule = lib.resolve(ref);
        if (rule) found.push(rule);
        else missing.push(ref);
      }
      if (!found.length) {
        return error(`No rule found for ${missing.map((m) => `"${m}"`).join(', ')}. Use search_rules or table_of_contents to find ids.`);
      }
      const parts = found.map((rule) => formatRuleContext(ruleContextView(lib, rule, include_subrules ?? true)));
      if (missing.length) parts.push(`Not found: ${missing.join(', ')}`);
      return text(parts.join('\n\n---\n\n'));
    },
  );

  server.registerTool(
    'lookup_term',
    {
      title: 'Look up a game term',
      description:
        'Look up a game term in the keyword index: its definition (Glossary entry or defining rule) and every rule and FAQ entry that uses it. ' +
        'Use it when the precise meaning of a word decides the ruling, e.g. "rule", "remove", "place", "adjacent", "enemy piece", "ambush card", "coalition".',
      inputSchema: z.object({
        term: z.string().min(1).describe('A game term, e.g. "remove" or "enemy piece"'),
      }),
      annotations: readOnly,
    },
    async ({ term }) => {
      const view = keywordView(lib, term);
      if (view) return text(formatKeyword(view));
      const suggestions = lib.suggestKeywords(term);
      return error(
        `"${term}" is not in the keyword index.` +
          (suggestions.length ? ` Similar terms: ${suggestions.map((k) => k.term).join(', ')}.` : '') +
          ' Try search_rules instead.',
      );
    },
  );

  server.registerTool(
    'table_of_contents',
    {
      title: 'Browse the Law of Root',
      description:
        'Without arguments: list all top-level sections (core rules, each faction, appendices) with faction nicknames. ' +
        'With a section id or faction name: the outline (ids and titles) of that section.',
      inputSchema: z.object({
        section: z.string().optional().describe('Section id or name, e.g. "9", "G", "Glossary", "vagabond", "cats"'),
      }),
      annotations: readOnly,
    },
    async ({ section }) => {
      if (!section) return text(formatToc(tocView(lib)));
      const rule = lib.resolveSection(section);
      return rule ? text(formatToc(tocView(lib, rule))) : error(`No section "${section}". Call table_of_contents without arguments to list sections.`);
    },
  );

  server.registerResource(
    'law-full',
    'root-rules://law/full',
    {
      title: 'The Law of Root (complete)',
      description: 'All rules, errata and FAQ in one Markdown document (~36k tokens)',
      mimeType: 'text/markdown',
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: renderFull(book) }] }),
  );

  server.registerResource(
    'law-faq',
    'root-rules://law/faq',
    { title: 'Law of Root FAQ', description: 'The official FAQ', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: renderFaq(book) }] }),
  );

  server.registerResource(
    'law-section',
    new ResourceTemplate('root-rules://law/section/{id}', {
      list: async () => ({
        resources: book.sections.map((id) => ({
          uri: `root-rules://law/section/${id}`,
          name: `${id}. ${book.rules[id]!.title}`,
          mimeType: 'text/markdown',
        })),
      }),
    }),
    { title: 'Law of Root section', description: 'One top-level section with its FAQ', mimeType: 'text/markdown' },
    async (uri, { id }) => {
      const rule = lib.resolveSection(String(id));
      if (!rule || rule.depth !== 1) throw new Error(`Unknown section ${String(id)}`);
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: renderSection(book, rule.id) }] };
    },
  );

  server.registerPrompt(
    'arbitrate',
    {
      title: 'Arbitrate a Root rules question',
      description: 'Rule on a game situation or rules question using the Law of Root, with citations',
      argsSchema: z.object({
        situation: z.string().describe('The game situation or question, including factions and board state that matter'),
      }),
    },
    ({ situation }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              `Act as a Root rules arbiter. Situation:\n\n${situation}\n\n` +
              'Research with the root-rules tools (search_rules, get_rules, lookup_term) before answering; do not rely on memory. ' +
              'Check faction abilities, cards and FAQ that could override general rules.\n\n' +
              'Answer in this format:\n' +
              '**Ruling:** one or two sentences.\n' +
              '**Why:** the reasoning, quoting the deciding rule text with ids (§x.y.z) and FAQ ids.\n' +
              '**Caveats:** anything the rules leave open or information that would change the ruling (omit if none).',
          },
        },
      ],
    }),
  );

  return server;
}
