// REST + OpenAPI 3.1 variant of the MCP tools, for clients that speak OpenAPI instead of MCP
// (custom GPT Actions, Open WebUI tool servers, scripts). Operation ids match the MCP tool names,
// so the same instructions apply; get_faq is REST-only (MCP's get_rules already includes FAQ).
// One route table drives both request handling and the spec.

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as z from 'zod/v4';
import type { RulebookLibrary } from '../library.ts';
import { INSTRUCTIONS, type LibraryProvider, SERVER_VERSION } from './mcp.ts';
import {
  FaqSchema, KeywordSchema, RuleContextSchema, SearchSchema, TocSchema, faqView, keywordView, ruleContextView,
  searchView, tocView,
} from './views.ts';

const ErrorSchema = z.object({
  error: z.string(),
  suggestions: z.array(z.string()).optional(),
});

type Result = { status: number; body: unknown };

interface Route {
  method: 'get';
  path: string;
  operationId: string;
  summary: string;
  /** Kept under 300 characters, the limit for GPT Actions. */
  description: string;
  pathParams?: Record<string, string>;
  query: z.ZodObject;
  response: z.ZodType;
  handle(lib: RulebookLibrary, params: Record<string, string>, query: any): Result;
}

const notFound = (error: string, suggestions?: string[]): Result => ({ status: 404, body: { error, suggestions } });

const routes: Route[] = [
  {
    method: 'get',
    path: '/api/search',
    operationId: 'search_rules',
    summary: 'Search the Law of Root',
    description:
      'Full-text search over all Root rules and the official FAQ. Use first to find the governing rules, then get_rules to read them. ' +
      'Rule ids in the query are looked up directly; faction nicknames like "cats" work.',
    query: z.object({
      q: z.string().min(1).describe('Keywords or a question, e.g. "ambush card defender battle"'),
      faction: z.string().optional().describe('Only rules of this faction, e.g. "vagabond", "cats"'),
      limit: z.coerce.number().int().min(1).max(25).optional().describe('Maximum results (default 8)'),
    }),
    response: SearchSchema,
    handle(lib, _params, { q, faction, limit }) {
      if (faction && !lib.findFaction(faction)) {
        return { status: 400, body: { error: `Unknown faction "${faction}"`, suggestions: Object.keys(lib.book.factions) } };
      }
      return { status: 200, body: searchView(lib, q, { faction, limit }) };
    },
  },
  {
    method: 'get',
    path: '/api/rules',
    operationId: 'get_rules',
    summary: 'Read rules by id',
    description:
      'Rules in full by id, with parent context, all sub-rules, applicable FAQ and errata, and cross-references. ' +
      'Accepts ids like 4.3.1, G.24, 9.2.9.IIIa or a section such as 9 or H.',
    query: z.object({
      ids: z.string().min(1).describe('Comma-separated rule ids, e.g. "4.3.1,G.24"'),
      subrules: z.enum(['true', 'false']).optional().describe('Include full text of sub-rules (default true)'),
    }),
    response: z.object({ rules: z.array(RuleContextSchema), notFound: z.array(z.string()) }),
    handle(lib, _params, { ids, subrules }) {
      const refs = (ids as string).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
      const found = refs.map((r) => lib.resolve(r));
      const rules = found.filter((r) => r !== undefined).map((r) => ruleContextView(lib, r, subrules !== 'false'));
      const missing = refs.filter((_, i) => !found[i]);
      if (!rules.length) return notFound(`No rule found for ${missing.join(', ')}`);
      return { status: 200, body: { rules, notFound: missing } };
    },
  },
  {
    method: 'get',
    path: '/api/terms/{term}',
    operationId: 'lookup_term',
    summary: 'Look up a game term',
    description:
      'Definition of a game term (Glossary entry or defining rule) and every rule and FAQ entry that uses it, ' +
      'e.g. "rule", "remove", "adjacent", "enemy piece". Use when the precise meaning of a word decides the ruling.',
    pathParams: { term: 'A game term, e.g. "remove" or "enemy piece"' },
    query: z.object({}),
    response: KeywordSchema,
    handle(lib, { term }) {
      const view = keywordView(lib, term!);
      if (view) return { status: 200, body: view };
      return notFound(`"${term}" is not in the keyword index`, lib.suggestKeywords(term!).map((k) => k.term));
    },
  },
  {
    method: 'get',
    path: '/api/faq/{id}',
    operationId: 'get_faq',
    summary: 'Read an FAQ entry',
    description: 'One official FAQ entry by id (e.g. FAQ-4), with the rules it clarifies.',
    pathParams: { id: 'FAQ id, e.g. "FAQ-4" or "4"' },
    query: z.object({}),
    response: FaqSchema,
    handle(lib, { id }) {
      const n = id!.replace(/^faq-?/i, '');
      const faq = lib.book.faq.find((f) => f.id === `FAQ-${n}`);
      return faq ? { status: 200, body: faqView(lib, faq) } : notFound(`No FAQ entry "${id}"`);
    },
  },
  {
    method: 'get',
    path: '/api/contents',
    operationId: 'table_of_contents',
    summary: 'Browse the Law of Root',
    description:
      'Without section: all top-level sections (core rules, factions, appendices) with faction nicknames. ' +
      'With section (id or faction name): the outline of that section.',
    query: z.object({
      section: z.string().optional().describe('Section id or name, e.g. "9", "G", "Glossary", "vagabond"'),
    }),
    response: TocSchema,
    handle(lib, _params, { section }) {
      if (!section) return { status: 200, body: tocView(lib) };
      const rule = lib.resolveSection(section);
      return rule ? { status: 200, body: tocView(lib, rule) } : notFound(`No section "${section}"`);
    },
  },
];

const jsonSchema = (schema: z.ZodType, io: 'input' | 'output' = 'output') => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io }) as Record<string, unknown>;
  return rest;
};

export function openApiDocument(serverUrl: string, requireAuth: boolean): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const shape = route.query.shape as Record<string, z.ZodType>;
    const parameters = [
      ...Object.entries(route.pathParams ?? {}).map(([name, description]) => ({
        name, in: 'path', required: true, description, schema: { type: 'string' },
      })),
      ...Object.entries(shape).map(([name, schema]) => {
        const { description, ...rest } = jsonSchema(schema, 'input');
        return { name, in: 'query', required: !schema.safeParse(undefined).success, description, schema: rest };
      }),
    ];
    const error = { description: 'Error', content: { 'application/json': { schema: jsonSchema(ErrorSchema) } } };
    paths[route.path] = {
      [route.method]: {
        operationId: route.operationId,
        summary: route.summary,
        description: route.description,
        parameters,
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: jsonSchema(route.response) } } },
          400: error,
          404: error,
          ...(requireAuth ? { 401: { description: 'Missing or wrong bearer token' } } : {}),
        },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: { title: 'Root Rules (Law of Root)', version: SERVER_VERSION, description: INSTRUCTIONS },
    servers: [{ url: serverUrl }],
    paths,
    ...(requireAuth
      ? { components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } }, security: [{ bearerAuth: [] }] }
      : {}),
  };
}

function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

function matchPath(template: string, pathname: string): Record<string, string> | undefined {
  const names: string[] = [];
  const re = new RegExp(`^${template.replace(/\{(\w+)\}/g, (_, name: string) => (names.push(name), '([^/]+)'))}$`);
  const m = re.exec(pathname);
  return m ? Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1]!)])) : undefined;
}

/** Handles /api/* requests. Returns false if no route matches the path. */
export function handleApi(getLibrary: LibraryProvider, req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  for (const route of routes) {
    const params = matchPath(route.path, url.pathname);
    if (!params) continue;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, { error: 'Method not allowed' });
      return true;
    }
    const parsed = route.query.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      send(res, 400, { error: z.prettifyError(parsed.error) });
      return true;
    }
    const { status, body } = route.handle(getLibrary(), params, parsed.data);
    send(res, status, body);
    return true;
  }
  return false;
}
