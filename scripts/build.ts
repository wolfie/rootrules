// Turn the upstream snapshot into LLM-friendly outputs:
//
//   dist/rulebook.json     structured rules (ids, hierarchy, cross-refs, FAQ links)
//   dist/rules.md          everything in one Markdown file, for pasting into a context window
//   dist/sections/*.md     one file per top-level section, with the FAQ entries that cite it
//   dist/faq.md            FAQ only
//   dist/keywords/*.md     reverse keyword index, one file per initial letter + index.md
//   dist/llms.txt          index of the above (https://llmstxt.org)

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  estimateTokens, keywordFileName, keywordsByLetter, renderFaq, renderFull, renderKeywordLetter,
  renderKeywordOverview, renderLlmsTxt, renderSection, sectionFileName,
} from '../src/markdown.ts';
import { buildRulebook } from '../src/rulebook.ts';
import { loadBuildInput, PROJECT_ROOT, snapshotDir } from '../src/snapshot.ts';

const OUT = path.join(PROJECT_ROOT, 'dist');

const book = buildRulebook(await loadBuildInput(snapshotDir('root', 'en-US')));

const files: Record<string, string> = {
  'rulebook.json': JSON.stringify(book, null, 2) + '\n',
  'rules.md': renderFull(book),
  'faq.md': renderFaq(book),
};
for (const id of book.sections) {
  files[`sections/${sectionFileName(book, id)}`] = renderSection(book, id);
}
files['keywords/index.md'] = renderKeywordOverview(book);
for (const [letter, entries] of keywordsByLetter(book)) {
  files[`keywords/${keywordFileName(letter)}`] = renderKeywordLetter(book, letter, entries);
}
files['llms.txt'] = renderLlmsTxt(book, files);

// Only clear what this script generates.
for (const dir of ['sections', 'keywords']) {
  await rm(path.join(OUT, dir), { recursive: true, force: true });
  await mkdir(path.join(OUT, dir), { recursive: true });
}
// Write-then-rename, so a running server never reads a half-written file.
for (const [name, content] of Object.entries(files)) {
  const file = path.join(OUT, name);
  await writeFile(`${file}.tmp`, content);
  await rename(`${file}.tmp`, file);
}

const { source, warnings } = book.meta;
console.log(
  `Built ${source.game}/${source.locale}/${source.printing} @ ${source.commit.slice(0, 7)}: ` +
    `${book.order.length} rules in ${book.sections.length} sections, ${book.faq.length} FAQ, ${book.errata.length} errata`,
);
console.log(`rules.md ~${Math.round(estimateTokens(files['rules.md']!) / 1000)}k tokens -> ${path.relative(process.cwd(), OUT) || '.'}`);

if (warnings.length) {
  console.warn(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.warn(`  - ${w}`);
}
