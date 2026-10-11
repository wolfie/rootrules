// Plain-Markdown rendering of the views for MCP tool output. Kept compact and explicit about rule
// ids so that small local models can cite them, and self-contained so one tool call is usually
// enough to rule.

import { citation } from '../rulebook.ts';
import type { KeywordView, RuleContextView, SearchView, TocView } from './views.ts';

type Ref = { id: string; title: string };

const pathLine = (path: Ref[]) => (path.length ? `Path: ${path.map((b) => `${b.id} ${b.title}`).join(' › ')}` : '');

const runIn = (r: Ref & { text: string }) => {
  const title = /[.?!:]$/.test(r.title) ? r.title : `${r.title}.`;
  return r.text ? `**${r.id} ${title}** ${r.text}` : `**${r.id} ${title}**`;
};

export function formatRuleContext(v: RuleContextView): string {
  const law = v.lawId !== v.id ? ` (printed Law: ${v.lawId})` : '';
  const subrules = v.subrules.length
    ? v.subrules.map((s) => [runIn(s), s.faq.length ? `_Clarified by ${s.faq.join(', ')}._` : ''].filter(Boolean).join('\n\n')).join('\n\n')
    : v.children.map((c) => `- ${citation(c)}`).join('\n');
  const faq = v.faq.map((f) => {
    const cites = f.rules.map(citation).join(', ');
    return [`#### ${f.id}`, `**Q:** ${f.question}`, `**A:** ${f.answer}`, cites ? `_Cites: ${cites}_` : '']
      .filter(Boolean).join('\n\n');
  });

  return [
    `## §${v.id} ${v.title}${law}`,
    [pathLine(v.path), v.faction ? `Faction: ${v.faction}` : ''].filter(Boolean).join('\n'),
    v.context.length
      ? `Context from parent rules:\n${v.context.map((c) => `> ${c.id} ${c.title}: ${c.text.replace(/\n+/g, ' ')}`).join('\n')}`
      : '',
    v.text || '_(heading only — see sub-rules)_',
    subrules ? `### Sub-rules\n\n${subrules}` : '',
    v.errata.length ? `### Errata\n\n${v.errata.map((e) => `${e.id}: ${e.text}`).join('\n\n')}` : '',
    faq.length ? `### FAQ\n\n${faq.join('\n\n')}` : '',
    v.refersTo.length ? `Refers to: ${v.refersTo.map(citation).join(', ')}` : '',
    v.referencedBy.length ? `Referenced by: ${v.referencedBy.map(citation).join(', ')}` : '',
  ].filter(Boolean).join('\n\n');
}

export function formatSearchResults(v: SearchView): string {
  if (!v.results.length) {
    return [
      `No rules matched "${v.query}".`,
      v.suggestions.length ? `Related game terms (try lookup_term): ${v.suggestions.join(', ')}` : '',
      'Try fewer or different words, a faction name, or table_of_contents to browse.',
    ].filter(Boolean).join('\n');
  }

  const blocks = v.results.map((hit) => {
    if (hit.type === 'faq') {
      const cites = hit.rules.map(citation).join(', ');
      return `### ${hit.id} (FAQ)\nQ: ${hit.question}\nA: ${hit.answer}${cites ? `\nCites: ${cites}` : ''}`;
    }
    const text = hit.text || `_(heading with ${hit.subruleCount} sub-rules)_`;
    const notes = [
      hit.subruleCount && hit.text ? `${hit.subruleCount} sub-rules` : '',
      hit.faq.length ? `FAQ: ${hit.faq.join(', ')}` : '',
    ].filter(Boolean).join(' · ');
    return [`### §${hit.id} ${hit.title}`, pathLine(hit.path), text, notes ? `(${notes})` : ''].filter(Boolean).join('\n');
  });

  return [
    `Results for "${v.query}" — use get_rules for full text, sub-rules, FAQ and cross-references before ruling.`,
    ...blocks,
  ].join('\n\n');
}

export function formatKeyword(v: KeywordView): string {
  const main = v.definedBy.map((r) =>
    [`### §${r.id} ${r.title}`, pathLine(r.path), r.text || '_(heading only)_'].filter(Boolean).join('\n'),
  );
  return [
    `## ${v.term}`,
    main.length ? `Defined / headed by:\n\n${main.join('\n\n')}` : '_No defining rule; see usages._',
    v.usedInCount
      ? `Used in ${v.usedInCount} other rules:\n${v.usedIn.map((u) => `- ${u.section.id}. ${u.section.title}: ${u.rules.join(', ')}`).join('\n')}`
      : '',
    v.faq.length ? `FAQ mentioning it:\n${v.faq.map((f) => `- ${f.id}: ${f.question}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

export function formatToc(v: TocView): string {
  if (!v.section) {
    const lines = v.entries.map((e) => {
      const aliases = e.faction ? ` — faction; also called: ${e.faction.aliases.join(', ')}` : '';
      return `- ${e.id}. ${e.title}${aliases}`;
    });
    return [
      'The Law of Root — top-level sections. Letters are appendices (G = Glossary).',
      lines.join('\n'),
      'Call table_of_contents with a section id or faction name for its outline, or get_rules to read it.',
    ].join('\n\n');
  }
  const top = v.entries[0]?.depth ?? 1;
  const lines = v.entries.map((e) => `${'  '.repeat(e.depth - top)}- ${e.id} ${e.title}`);
  return [`Outline of §${v.section.id} ${v.section.title}:`, lines.join('\n')].join('\n\n');
}
