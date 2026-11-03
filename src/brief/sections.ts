import { outsideFences } from './index.ts';

/** Invalid sections carry bounded reasons, without echoing their body. */
export class BriefSectionsError extends Error {
  readonly reasons: string[];
  readonly hasAllowed: boolean;
  constructor(reasons: string[], hasAllowed: boolean) {
    super(reasons.join('\n'));
    this.reasons = reasons;
    this.hasAllowed = hasAllowed;
  }
}

export function briefSections(text: string): {
  allowed: { path: string; isNew: boolean }[] | undefined;
  steps: string[] | undefined;
  observer: string | undefined;
  settled: string | undefined;
} {
  const names = ['Allowed paths', 'Steps', 'Proof', 'Settled decisions'];
  const bodies = new Map<string, string[]>();
  const reasons: string[] = [];
  const raw = text.split('\n');
  let active: string | undefined;
  let settledStart: number | undefined;
  let settledEnd = raw.length;
  for (const { line, number } of outsideFences(text)) {
    const heading = /^ {0,3}##[\t ]+(.+?)(?:[\t ]+#+)?[\t ]*$/u.exec(line);
    if (heading) {
      if (active === 'Settled decisions' && settledStart !== undefined)
        settledEnd = number - 1;
      active = heading[1];
      if (!active || !names.includes(active)) {
        active = undefined;
        continue;
      }
      if (bodies.has(active)) {
        if (reasons.length < 64)
          reasons.push(`duplicate ${active} section at line ${number}`);
        active = undefined;
        continue;
      }
      bodies.set(active, []);
      if (active === 'Settled decisions') settledStart = number;
    } else if (/^ {0,3}#[\t ]/u.test(line)) {
      if (active === 'Settled decisions') settledEnd = number - 1;
      active = undefined;
    } else if (active) bodies.get(active)?.push(line);
  }
  const allowedBody = bodies.get('Allowed paths');
  const allowed = allowedBody
    ?.flatMap((line) => line.replace(/^ {0,3}-[\t ]+/u, '').split(','))
    .map((entry) => {
      const annotation = /[\t ]*\(([^()]*)\)[\t ]*$/u.exec(entry);
      const path = (annotation ? entry.slice(0, annotation.index) : entry)
        .trim()
        .replace(/^`(.*)`$/u, '$1');
      return { path, isNew: annotation?.[1] === 'new' };
    })
    .filter((entry) => entry.path !== '');
  if (allowed?.length === 0) reasons.push('empty Allowed paths section');
  if (allowed && allowed.length > 100)
    reasons.push('Allowed paths exceeds 100 entries');
  if (
    allowed?.some(
      (entry) =>
        /[`\p{Cc}]/u.test(entry.path) || Buffer.byteLength(entry.path) > 4096,
    )
  )
    reasons.push('malformed Allowed paths entry');
  const stepsBody = bodies.get('Steps');
  let stepNumber = 0;
  const steps = stepsBody?.flatMap((line) => {
    const item = /^ {0,3}(\d+)\.[\t ]+(.+)$/u.exec(line);
    if (!item) return [];
    if (Number(item[1]) !== ++stepNumber && reasons.length < 64)
      reasons.push('malformed Steps numbering');
    return item[2] ? [item[2]] : [];
  });
  const observer = bodies
    .get('Proof')
    ?.join('\n')
    .replaceAll('`', '')
    .split(/\s+/u)
    .find((token) =>
      /^test\/(?:[^\s/]+\/)*[^\s/]+\.test\.(?:ts|mjs|js|cjs)$/u.test(token),
    );
  if (reasons.length)
    throw new BriefSectionsError(
      reasons.slice(0, 64),
      bodies.has('Allowed paths'),
    );
  return {
    allowed,
    steps,
    observer,
    settled:
      settledStart === undefined
        ? undefined
        : raw.slice(settledStart, settledEnd).join('\n') +
          (settledEnd < raw.length ? '\n' : ''),
  };
}
