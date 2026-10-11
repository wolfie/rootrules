// Rule numbering follows the upstream site (LederCards/rules): top-level sections are
// numbered 1..n, but appendix sections display a letter instead (21 -> "G"). Depth 4 and 5
// are dotted numbers in headings, while the printed Law writes them as roman numeral +
// letter ("9.2.9.3.1" == "9.2.9.IIIa"). Every form is accepted when resolving a reference.

const ROMAN: [number, string][] = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

export function toRoman(n: number): string {
  let out = '';
  for (const [value, numeral] of ROMAN) {
    while (n >= value) {
      out += numeral;
      n -= value;
    }
  }
  return out;
}

export function fromRoman(s: string): number | undefined {
  const upper = s.toUpperCase();
  if (!/^[IVXLCDM]+$/.test(upper)) return undefined;
  let total = 0;
  let rest = upper;
  for (const [value, numeral] of ROMAN) {
    while (rest.startsWith(numeral)) {
      total += value;
      rest = rest.slice(numeral.length);
    }
  }
  return rest === '' && toRoman(total) === upper ? total : undefined;
}

/** Printed-Law label for a display path, e.g. ["9","2","9","3","1"] -> "9.2.9.IIIa". */
export function lawLabel(displayPath: string[]): string {
  const [a, b, c, d, e] = displayPath;
  let label = [a, b, c].filter((x) => x !== undefined).join('.');
  if (d !== undefined) label += `.${toRoman(+d)}`;
  if (e !== undefined) label += String.fromCharCode(96 + +e);
  return label;
}

/**
 * Normalize any accepted spelling of a rule reference to the canonical id form.
 * `appendixByNumber` maps a top-level section number ("21") to its appendix letter ("G").
 *
 * Accepts e.g. "9.2.9.3.1", "9.2.9.IIIa", "9.2.9.III.a", "21.24", "g.24", "§4.1", "rule 22.".
 * Leading "§"/"rule"/"rule:" and trailing dots are ignored. Returns undefined if unparseable;
 * the result is not guaranteed to exist in the rulebook.
 */
export function normalizeRuleRef(
  input: string,
  appendixByNumber: ReadonlyMap<string, string>,
): string | undefined {
  const s = input
    .trim()
    .replace(/^(§|rules?:?)\s*/i, '')
    .replace(/\.+$/, '')
    .trim();
  const parts = s.split('.').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;

  const first = parts[0]!;
  if (/^\d+$/.test(first)) {
    parts[0] = appendixByNumber.get(String(+first)) ?? String(+first);
  } else if (/^[a-z]$/i.test(first)) {
    parts[0] = first.toUpperCase();
  } else {
    return undefined;
  }

  const out = [parts[0]!];
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]!;
    if (/^\d+$/.test(part)) {
      out.push(String(+part));
      continue;
    }
    // Depth 4 may be a roman numeral, optionally with the depth-5 letter glued on ("IIIa").
    if (i === 3) {
      const whole = fromRoman(part);
      if (whole !== undefined) {
        out.push(String(whole));
        continue;
      }
      const glued = /^([ivxlcdm]+)([a-z])$/i.exec(part);
      const romanValue = glued ? fromRoman(glued[1]!) : undefined;
      if (glued && romanValue !== undefined) {
        out.push(String(romanValue), String(glued[2]!.toLowerCase().charCodeAt(0) - 96));
        continue;
      }
    }
    // Depth 5 may be a lone letter ("9.2.9.III.a").
    if (i === 4 && /^[a-z]$/i.test(part)) {
      out.push(String(part.toLowerCase().charCodeAt(0) - 96));
      continue;
    }
    return undefined;
  }
  return out.join('.');
}
