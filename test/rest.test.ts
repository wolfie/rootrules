import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { RulebookLibrary } from '../src/library.ts';
import { buildRulebook } from '../src/rulebook.ts';
import { createHttpServer } from '../src/server/http.ts';
import { loadBuildInput, snapshotDir } from '../src/snapshot.ts';

const TOKEN = 'test-token';
const lib = new RulebookLibrary(buildRulebook(await loadBuildInput(snapshotDir('root', 'en-US'))));
const server = createHttpServer({
  getLibrary: () => lib,
  token: TOKEN,
  allowedHosts: ['127.0.0.1', 'localhost', 'webui.example'],
});
let base: string;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const get = async (path: string, headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }) => {
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, headers: res.headers, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
};

test('openapi.json is public and describes the operations', async () => {
  const { status, body } = await get('/openapi.json', {});
  assert.equal(status, 200);
  assert.equal(body.openapi, '3.1.0');
  assert.equal(body.servers[0].url, base);
  const ops = Object.values(body.paths as Record<string, { get: { operationId: string } }>).map((p) => p.get.operationId);
  assert.deepEqual(ops.sort(), ['get_faq', 'get_rules', 'lookup_term', 'search_rules', 'table_of_contents']);
  assert.deepEqual(body.security, [{ bearerAuth: [] }]);
  const params = body.paths['/api/search'].get.parameters;
  assert.deepEqual(params.find((p: { name: string }) => p.name === 'q').required, true);
  assert.deepEqual(params.find((p: { name: string }) => p.name === 'limit').schema.type, 'integer');
  for (const path of Object.values(body.paths) as { get: { description: string } }[]) {
    assert.ok(path.get.description.length <= 300, path.get.description);
  }
});

test('api requires the bearer token', async () => {
  assert.equal((await get('/api/search?q=ambush', {})).status, 401);
});

test('search returns structured rule and FAQ hits', async () => {
  const { status, body } = await get('/api/search?q=can+I+play+an+ambush+card+when+defending&limit=5');
  assert.equal(status, 200);
  assert.ok(body.results.some((r: { type: string; id: string }) => r.type === 'rule' && r.id === '4.3.1'));
  assert.ok(body.results.some((r: { type: string }) => r.type === 'faq'));
});

test('search validates parameters', async () => {
  assert.equal((await get('/api/search')).status, 400);
  assert.equal((await get('/api/search?q=x&limit=99')).status, 400);
  assert.equal((await get('/api/search?q=x&faction=dragons')).status, 400);
});

test('rules returns full context and reports unknown ids', async () => {
  const { status, body } = await get('/api/rules?ids=9.2.9.IIIa,99.1');
  assert.equal(status, 200);
  assert.equal(body.rules[0].id, '9.2.9.3.1');
  assert.equal(body.rules[0].lawId, '9.2.9.IIIa');
  assert.ok(body.rules[0].context.some((c: { id: string }) => c.id === '9.2.9.3'));
  assert.deepEqual(body.notFound, ['99.1']);
  assert.equal((await get('/api/rules?ids=99.1')).status, 404);
});

test('terms resolves inflections and 404s with suggestions', async () => {
  const { body } = await get('/api/terms/removed');
  assert.equal(body.term, 'Remove');
  const missing = await get('/api/terms/removals%20galore');
  assert.equal(missing.status, 404);
  assert.ok(Array.isArray(missing.body.suggestions));
});

test('faq entries are readable by id', async () => {
  const { status, body } = await get('/api/faq/faq-4');
  assert.equal(status, 200);
  assert.equal(body.id, 'FAQ-4');
  assert.match(body.question, /ambush/i);
  assert.equal((await get('/api/faq/999')).status, 404);
});

test('contents resolves faction nicknames', async () => {
  const { body } = await get('/api/contents?section=birds');
  assert.equal(body.section.id, '7');
});

test('CORS preflight is answered for allowed origins only', async () => {
  const ok = await fetch(`${base}/api/search`, { method: 'OPTIONS', headers: { Origin: 'https://webui.example' } });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://webui.example');
  const bad = await fetch(`${base}/api/search`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  assert.equal(bad.status, 403);
});
