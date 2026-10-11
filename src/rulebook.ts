import { parse } from 'yaml';
import { FACTION_ALIASES } from './factions.ts';
import { lawLabel, normalizeRuleRef } from './ids.ts';
import { buildKeywordIndex } from './keywords.ts';
import type { ErrataEntry, Faction, FaqEntry, Rule, Rulebook, SourceInfo } from './types.ts';

interface RawRule {
  name: string;
  plainName?: string;
  pretext?: string;
  text?: string;
  appendix?: string;
  icon?: string;
  children?: RawRule[];
}

interface RawFaq {
  q: string;
  a: string;
  rules?: string[];
}

interface RawErrata {
  text: string;
  printings?: string[];
  rules?: string[];
}

export interface BuildInput {
  rulesYaml: string;
  faqYaml?: string;
  errataYaml?: string;
  appconfigYaml?: string;
  source: SourceInfo;
}

const HIRELING_ICONS: Record<string, string> = {
  whenhired: 'when-hired',
  ability: 'ability',
  birdsong: 'birdsong',
  daylight: 'daylight',
};

// Upstream marks inline icons and cross-references as code spans, e.g. `rule:4.1.1`,
// `item:sword`, `faction:cult$10.2.6`, `hireling:birdsong`.
const MARKER = /`([a-z-]+):([^`]*)`/g;

// The failsafe schema keeps every scalar a string, so refs like 2.10 don't become 2.1.
const parseYaml = <T>(src: string): T => parse(src, { schema: 'failsafe' }) as T;

const plain = (s: string) => s.replace(/[*_]/g, '').replace(/\s+/g, ' ').trim();

export function buildRulebook(input: BuildInput): Rulebook {
  const warnings: string[] = [];
  const raw = parseYaml<RawRule[]>(input.rulesYaml);

  const appendixByNumber = new Map<string, string>();
  raw.forEach((section, i) => {
    if (section.appendix) appendixByNumber.set(String(i + 1), section.appendix.trim().toUpperCase());
  });

  const rules: Record<string, Rule> = {};
  const order: string[] = [];
  const sources = new Map<string, RawRule>();
  const factions: Record<string, Faction> = {};

  // Pass 1: assign ids and structure.
  const walk = (node: RawRule, path: number[], parent: Rule | null, faction: string | undefined) => {
    const top = String(path[0]);
    const displayPath = [appendixByNumber.get(top) ?? top, ...path.slice(1).map(String)];
    const id = displayPath.join('.');
    if (rules[id]) warnings.push(`Duplicate rule id ${id}`);

    const rule: Rule = {
      id,
      numericId: path.join('.'),
      lawId: lawLabel(displayPath),
      title: renderTitle(node.plainName ?? node.name),
      depth: path.length,
      parent: parent?.id ?? null,
      children: [],
      breadcrumb: parent ? [...parent.breadcrumb, { id: parent.id, title: parent.title }] : [],
      faction,
      text: '',
      refs: [],
      refBy: [],
      faq: [],
      errata: [],
    };
    rules[id] = rule;
    order.push(id);
    sources.set(id, node);
    parent?.children.push(id);

    (node.children ?? []).forEach((child, i) => walk(child, [...path, i + 1], rule, faction));
  };

  raw.forEach((section, i) => {
    const factionKey = section.icon?.startsWith('faction-') ? section.icon.slice('faction-'.length) : undefined;
    walk(section, [i + 1], null, factionKey);
    if (factionKey) {
      const sectionId = appendixByNumber.get(String(i + 1)) ?? String(i + 1);
      const name = plain(section.name);
      factions[factionKey] = {
        key: factionKey,
        name,
        sectionId,
        aliases: [...new Set([name.toLowerCase(), ...(FACTION_ALIASES[factionKey] ?? [])])],
      };
    }
  });

  const resolve = (ref: string): Rule | undefined => {
    const id = normalizeRuleRef(ref, appendixByNumber);
    return id ? rules[id] : undefined;
  };

  // Pass 2: render text, resolving markers and recording cross-references.
  const renderText = (src: string, where: string, refs?: Set<string>) =>
    src.trim().replace(MARKER, (whole, type: string, value: string) => {
      switch (type) {
        case 'rule': {
          const target = resolve(value);
          if (!target) {
            warnings.push(`${where}: unresolved rule reference ${whole}`);
            return `§${value}`;
          }
          refs?.add(target.id);
          return citation(target);
        }
        case 'faction': {
          const [key = '', ref] = value.split('$');
          const name = factions[key]?.name ?? key;
          if (!factions[key]) warnings.push(`${where}: unknown faction ${whole}`);
          if (!ref) return name;
          const target = resolve(ref);
          if (!target) {
            warnings.push(`${where}: unresolved faction reference ${whole}`);
            return `(${name} exception: §${ref})`;
          }
          refs?.add(target.id);
          return `(${name} exception: ${citation(target)})`;
        }
        case 'item':
          return value;
        case 'hireling':
          return `[${HIRELING_ICONS[value] ?? value} icon]`;
        default:
          warnings.push(`${where}: unknown marker ${whole}`);
          return whole;
      }
    });

  for (const id of order) {
    const rule = rules[id]!;
    const node = sources.get(id)!;
    const refs = new Set<string>();
    rule.text = [node.pretext, node.text]
      .filter((s): s is string => !!s && !!s.trim())
      .map((s) => renderText(s, `rule ${id}`, refs))
      .join('\n\n');
    refs.delete(id);
    rule.refs = [...refs];
    for (const ref of rule.refs) rules[ref]!.refBy.push(id);
  }

  // FAQ and errata cite rules in display form ("G.24"); attach them to the cited rules.
  const attach = (refs: string[] | undefined, where: string, onRule: (rule: Rule) => void) => {
    const ids: string[] = [];
    for (const ref of refs ?? []) {
      const rule = resolve(ref);
      if (!rule) {
        warnings.push(`${where}: unresolved rule reference "${ref}"`);
        continue;
      }
      if (!ids.includes(rule.id)) {
        ids.push(rule.id);
        onRule(rule);
      }
    }
    return ids;
  };

  const faq: FaqEntry[] = (input.faqYaml ? parseYaml<RawFaq[] | null>(input.faqYaml) ?? [] : []).map((entry, i) => {
    const id = `FAQ-${i + 1}`;
    return {
      id,
      question: renderText(entry.q, id),
      answer: renderText(entry.a, id),
      rules: attach(entry.rules, id, (rule) => rule.faq.push(id)),
    };
  });

  const errata: ErrataEntry[] = (input.errataYaml ? parseYaml<RawErrata[] | null>(input.errataYaml) ?? [] : [])
    .filter((entry) => !entry.printings?.length || entry.printings.includes(input.source.printing))
    .map((entry, i) => {
      const id = `ERRATA-${i + 1}`;
      return {
        id,
        text: renderText(entry.text, id),
        rules: attach(entry.rules, id, (rule) => rule.errata.push(id)),
      };
    });

  let upstreamUpdated: string | undefined;
  if (input.appconfigYaml) {
    const config = parseYaml<{ App?: { NavTitle?: string } }>(input.appconfigYaml);
    upstreamUpdated = config.App?.NavTitle?.replace(/^Updated\s+/i, '');
  }

  const book = {
    meta: {
      title: 'The Law of Root',
      source: input.source,
      upstreamUpdated,
      builtAt: new Date().toISOString(),
      warnings,
    },
    order,
    sections: order.filter((id) => rules[id]!.depth === 1),
    rules,
    faq,
    errata,
    factions,
  };
  return { ...book, keywords: buildKeywordIndex(book) };
}

/** How a cross-reference is written inline, e.g. "§4.1.1 [Crafting]". */
export function citation(rule: Pick<Rule, 'id' | 'title'>): string {
  return `§${rule.id} [${rule.title}]`;
}

// Titles only ever contain hireling icons (as decoration), so drop markers instead of
// resolving them, along with any parentheses left empty.
function renderTitle(name: string): string {
  return plain(name.replace(MARKER, ''))
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([.,:;])/g, '$1')
    .replace(/\.$/, '')
    .trim();
}
