// Download the latest rules, FAQ, errata and app config for one game/locale from the
// upstream LederCards/rules repository into upstream/<game>/<locale>/.
//
//   npm run fetch    # newest printing on master
//
// Set GITHUB_TOKEN to raise the GitHub API rate limit (60 requests/hour unauthenticated).

import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { readSource, SNAPSHOT_FILES, snapshotDir } from '../src/snapshot.ts';
import type { SourceInfo } from '../src/types.ts';

const REPO = 'LederCards/rules';
const REF = 'master';
const GAME = 'root';
const LOCALE = 'en-US';

const headers: Record<string, string> = {
  'User-Agent': 'rootrules-fetch',
  Accept: 'application/vnd.github+json',
};
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function api<T>(endpoint: string): Promise<T> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/${endpoint}`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${endpoint}: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

async function raw(commit: string, file: string): Promise<string | undefined> {
  const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${commit}/${file}`, { headers });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`Download ${file}: ${res.status} ${res.statusText}`);
  return res.text();
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const localeDir = `content/rules/${GAME}/${LOCALE}`;

// The newest commit touching this locale identifies the rules version.
const [latest] = await api<{ sha: string; commit: { committer: { date: string } } }[]>(
  `commits?sha=${encodeURIComponent(REF)}&path=${localeDir}&per_page=1`,
);
if (!latest) throw new Error(`No commits found for ${localeDir} at ${REF}`);

const entries = await api<{ name: string; type: string }[]>(`contents/${localeDir}?ref=${latest.sha}`);
const printing = entries
  .filter((e) => e.type === 'dir' && /^p\d+$/.test(e.name))
  .map((e) => e.name)
  .sort((a, b) => +a.slice(1) - +b.slice(1))
  .at(-1);
if (!printing) throw new Error(`No printings (p<N> directories) found in ${localeDir}`);

const upstreamPaths: Record<(typeof SNAPSHOT_FILES)[number], string> = {
  'rules.yml': `${localeDir}/${printing}/rules.yml`,
  'faq.yml': `${localeDir}/${printing}/faq.yml`,
  'errata.yml': `${localeDir}/errata.yml`,
  'appconfig.yml': `${localeDir}/appconfig.yml`,
};

const contents: Record<string, string> = {};
for (const name of SNAPSHOT_FILES) {
  const text = await raw(latest.sha, upstreamPaths[name]);
  if (text === undefined) {
    if (name === 'rules.yml') throw new Error(`${upstreamPaths[name]} not found at ${latest.sha}`);
    continue;
  }
  try {
    parse(text);
  } catch (e) {
    throw new Error(`${upstreamPaths[name]} is not valid YAML: ${(e as Error).message}`);
  }
  contents[name] = text;
}

const source: SourceInfo = {
  repo: REPO,
  commit: latest.sha,
  commitDate: latest.commit.committer.date,
  fetchedAt: new Date().toISOString(),
  game: GAME,
  locale: LOCALE,
  printing,
  files: Object.fromEntries(Object.entries(contents).map(([name, text]) => [name, sha256(text)])),
};

const dir = snapshotDir(GAME, LOCALE);
const previous = await readSource(dir);
const changed = SNAPSHOT_FILES.filter((name) => previous?.files[name] !== source.files[name]);

if (previous && previous.printing === printing && changed.length === 0) {
  console.log(`Up to date: ${GAME}/${LOCALE}/${printing} @ ${latest.sha.slice(0, 7)} (${source.commitDate})`);
  process.exit(0);
}

// Write to a sibling directory and swap, so a failed fetch never leaves a half-updated snapshot.
const tmp = `${dir}.tmp`;
await rm(tmp, { recursive: true, force: true });
await mkdir(tmp, { recursive: true });
for (const [name, text] of Object.entries(contents)) await writeFile(path.join(tmp, name), text);
await writeFile(path.join(tmp, 'source.json'), JSON.stringify(source, null, 2) + '\n');
await rm(dir, { recursive: true, force: true });
await rename(tmp, dir);

const from = previous ? `${previous.printing} @ ${previous.commit.slice(0, 7)}` : 'nothing';
console.log(`Updated ${GAME}/${LOCALE}: ${from} -> ${printing} @ ${latest.sha.slice(0, 7)} (${source.commitDate})`);
console.log(`Changed: ${changed.map((n) => (source.files[n] ? n : `${n} (removed)`)).join(', ')}`);
console.log(`Snapshot: ${path.relative(process.cwd(), dir)}`);
