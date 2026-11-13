// Clone detector for the sibling-transplant measurement. The two constants are fixed
// before any result was read; changing them invalidates the recorded run.
export const SHINGLE = 3;
export const THRESHOLD = 0.6;
export const MIN_TOKENS = 25;

export type Lang = 'ts' | 'py';
export interface TestCase {
  name: string;
  body: string;
}

const TS_DECL = /(^|[^\w.$])(it|test)(\.(?:only|skip|concurrent|todo|fails))*\s*\(\s*(['"`])/g;
const TS_PATH = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const PY_PATH = /(^|\/)(tests?\/|test_[^/]*\.py$)|_test\.py$/;

export function isTestPath(path: string, lang: Lang): boolean {
  return lang === 'ts' ? TS_PATH.test(path) && /\.[cm]?[jt]sx?$/.test(path) : PY_PATH.test(path) && path.endsWith('.py');
}

// Index just past the closing paren of the call whose "(" is at `open`, skipping strings, templates and comments.
function callEnd(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 1;
    } else if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return src.length;
}

function tsCases(src: string): TestCase[] {
  const out: TestCase[] = [];
  for (const m of src.matchAll(TS_DECL)) {
    const quote = m[4] as string;
    const start = m.index + (m[1] ?? '').length;
    const open = src.indexOf('(', start);
    const nameStart = open + src.slice(open).indexOf(quote) + 1;
    let i = nameStart;
    while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
    out.push({ name: src.slice(nameStart, i), body: src.slice(start, callEnd(src, open)) });
  }
  return out;
}

function pyCases(src: string): TestCase[] {
  const lines = src.split('\n');
  const out: TestCase[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:async\s+)?def\s+(test\w*)\s*\(/.exec(lines[i] ?? '');
    if (!m) continue;
    const indent = (m[1] ?? '').length;
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j] ?? '';
      if (l.trim() !== '' && l.length - l.trimStart().length <= indent) break;
      j++;
    }
    out.push({ name: m[2] as string, body: lines.slice(i, j).join('\n') });
  }
  return out;
}

export function extractCases(src: string, lang: Lang): TestCase[] {
  return lang === 'ts' ? tsCases(src) : pyCases(src);
}

const KEYWORDS = new Set(
  `async await function return const let var if else for while in of new try catch throw def class import from as with assert raise lambda not and or is None True False null undefined true false this self`.split(
    ' ',
  ),
);

// Abstract tokens: literals become S or N, non-keyword identifiers become I, punctuation stays.
export function abstractTokens(body: string): string[] {
  const re = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\d[\w.]*|[A-Za-z_$][\w$]*|[^\s\w]/g;
  const out: string[] = [];
  for (const [t] of body.matchAll(re)) {
    const c = t[0] as string;
    if (c === '"' || c === "'" || c === '`') out.push('S');
    else if (/\d/.test(c)) out.push('N');
    else if (/[A-Za-z_$]/.test(c)) out.push(KEYWORDS.has(t) ? t : 'I');
    else out.push(t);
  }
  return out;
}

export interface Fingerprint {
  tokens: number;
  shingles: Set<string>;
}

export function fingerprint(body: string): Fingerprint {
  const tokens = abstractTokens(body);
  const shingles = new Set<string>();
  for (let i = 0; i + SHINGLE <= tokens.length; i++) shingles.add(tokens.slice(i, i + SHINGLE).join(' '));
  return { tokens: tokens.length, shingles };
}

export function similarity(a: Fingerprint, b: Fingerprint): number {
  if (a.shingles.size === 0 || b.shingles.size === 0) return 0;
  const [small, large] = a.shingles.size <= b.shingles.size ? [a, b] : [b, a];
  let both = 0;
  for (const s of small.shingles) if (large.shingles.has(s)) both++;
  return both / (a.shingles.size + b.shingles.size - both);
}

export function nearest(target: Fingerprint, pool: readonly Fingerprint[]): number {
  let best = 0;
  for (const p of pool) best = Math.max(best, similarity(target, p));
  return best;
}

export function hasAncestor(similarityScore: number): boolean {
  return similarityScore >= THRESHOLD;
}

export function wilson(k: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const w = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: (c - w) / d, hi: (c + w) / d };
}

// Cluster bootstrap over PRs (resample PRs, keep their cases together); seeded so the record reproduces.
export function clusterBootstrap(
  prs: readonly { hits: number; n: number }[],
  rounds = 5000,
): { lo: number; hi: number } {
  let seed = 12345;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const shares: number[] = [];
  for (let r = 0; r < rounds; r++) {
    let k = 0;
    let n = 0;
    for (let i = 0; i < prs.length; i++) {
      const p = prs[Math.floor(rand() * prs.length)];
      k += p?.hits ?? 0;
      n += p?.n ?? 0;
    }
    if (n > 0) shares.push(k / n);
  }
  shares.sort((a, b) => a - b);
  return { lo: shares[Math.floor(0.025 * shares.length)] ?? 0, hi: shares[Math.ceil(0.975 * shares.length) - 1] ?? 1 };
}

export function isFix(subject: string): boolean {
  return /^(fix|bugfix|hotfix)\b|\b(fix|fixes|fixed|bug|regression)\b/i.test(subject);
}
