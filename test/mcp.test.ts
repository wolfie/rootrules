import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { RulebookLibrary } from '../src/library.ts';
import { buildRulebook } from '../src/rulebook.ts';
import { createHttpServer } from '../src/server/http.ts';
import { loadBuildInput, snapshotDir } from '../src/snapshot.ts';

const TOKEN = 'test-token';
const lib = new RulebookLibrary(buildRulebook(await loadBuildInput(snapshotDir('root', 'en-US'))));
const server = createHttpServer({ getLibrary: () => lib, token: TOKEN, allowedHosts: ['127.0.0.1', 'localhost'] });
let base: string;
let client: Client;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }),
  );
});

after(async () => {
  await client.close();
  server.close();
});

const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return { text: content.map((c) => c.text).join('\n'), isError: !!result.isError };
};

test('rejects requests without the bearer token', async () => {
  const res = await fetch(`${base}/mcp`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  assert.equal(res.status, 401);
});

test('rejects unknown Host headers', async () => {
  // fetch() won't let us override Host, so use node:http directly.
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(`${base}/mcp`, {
      method: 'POST',
      headers: { Host: 'evil.example', Authorization: `Bearer ${TOKEN}` },
    }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('exposes instructions and the four tools', async () => {
  assert.match(client.getInstructions() ?? '', /Do not answer rules questions from memory/);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['get_rules', 'lookup_term', 'search_rules', 'table_of_contents']);
});

test('search_rules finds the governing rule and FAQ', async () => {
  const { text } = await call('search_rules', { query: 'can I play an ambush card when defending' });
  assert.match(text, /§4\.3\.1 Step 1: Defender May Ambush/);
  assert.match(text, /FAQ-\d+ \(FAQ\)/);
});

test('search_rules filters by faction nickname', async () => {
  const { text } = await call('search_rules', { query: 'battle', faction: 'cats' });
  const ids = [...text.matchAll(/^### §([\w.]+)/gm)].map((m) => m[1]!);
  assert.ok(ids.length > 0);
  assert.ok(ids.every((id) => id.startsWith('6')), ids.join(','));
});

test('get_rules returns context, sub-rules, FAQ and cross-references', async () => {
  const { text } = await call('get_rules', { ids: ['9.2.9.IIIa', '9.2.2'] });
  assert.match(text, /## §9\.2\.9\.3\.1 Infamy \(printed Law: 9\.2\.9\.IIIa\)/);
  assert.match(text, /Context from parent rules:\n> 9\.2\.9 Relationships:.*\n> 9\.2\.9\.3 Hostile Status:/);
  assert.match(text, /\*\*9\.2\.2\.1 Full Removal\.\*\*/);
  assert.match(text, /#### FAQ-5/);
});

test('get_rules reports unknown ids', async () => {
  const { text, isError } = await call('get_rules', { ids: ['99.1'] });
  assert.ok(isError);
  assert.match(text, /No rule found/);
});

test('lookup_term returns definition and usages', async () => {
  const { text } = await call('lookup_term', { term: 'removed' });
  assert.match(text, /## Remove/);
  assert.match(text, /§G\.\d+ Remove/);
  assert.match(text, /Used in \d+ other rules/);
});

test('table_of_contents resolves faction names', async () => {
  const { text } = await call('table_of_contents', { section: 'birds' });
  assert.match(text, /Outline of §7 Eyrie Dynasties/);
});

test('resources and prompt are available', async () => {
  const { resources } = await client.listResources();
  assert.ok(resources.some((r) => r.uri === 'root-rules://law/section/G'));
  const section = await client.readResource({ uri: 'root-rules://law/section/G' });
  assert.match((section.contents[0] as { text: string }).text, /# The Law of Root — G\. Glossary/);
  const prompt = await client.getPrompt({ name: 'arbitrate', arguments: { situation: 'Can cats ambush?' } });
  assert.match((prompt.messages[0]!.content as { text: string }).text, /Can cats ambush\?/);
});
