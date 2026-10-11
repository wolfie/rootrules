import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildInput } from './rulebook.ts';
import type { SourceInfo } from './types.ts';

export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Local copy of the upstream files for one game/locale, as written by `scripts/fetch.ts`. */
export const snapshotDir = (game: string, locale: string) =>
  path.join(PROJECT_ROOT, 'upstream', game, locale);

export const SNAPSHOT_FILES = ['rules.yml', 'faq.yml', 'errata.yml', 'appconfig.yml'] as const;

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

export async function readSource(dir: string): Promise<SourceInfo | undefined> {
  const json = await readOptional(path.join(dir, 'source.json'));
  return json ? (JSON.parse(json) as SourceInfo) : undefined;
}

export async function loadBuildInput(dir: string): Promise<BuildInput> {
  const source = await readSource(dir);
  const rulesYaml = await readOptional(path.join(dir, 'rules.yml'));
  if (!source || !rulesYaml) {
    throw new Error(`No rules snapshot in ${dir}. Run \`npm run fetch\` first.`);
  }
  return {
    source,
    rulesYaml,
    faqYaml: await readOptional(path.join(dir, 'faq.yml')),
    errataYaml: await readOptional(path.join(dir, 'errata.yml')),
    appconfigYaml: await readOptional(path.join(dir, 'appconfig.yml')),
  };
}
