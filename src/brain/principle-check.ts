// Whether a rule text states a principle or retells one incident. A rule must still hold after
// the incident is forgotten; the incident is evidence and belongs in the record's evidence.
// Pure judgement over strings: callers (proposal parsing, candidate ingest, the record-file rule
// test) own where the text comes from and how a refusal is reported.

export type PrincipleInput = {
  readonly text: string;
  /** The record's evidence entries; a name the text shares with them points at one case. */
  readonly evidence?: readonly string[];
  /** A text that names the check enforcing it may name that check's files. */
  readonly enforced?: boolean;
};

export type PrincipleVerdict =
  | { readonly principle: true }
  | { readonly principle: false; readonly signals: readonly string[] };

// One of these alone ties the text to a single event.
const HARD: readonly (readonly [string, RegExp])[] = [
  ['a pull request number', /(?<![\w/])#\d+\b/u],
  ['a commit SHA', /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b(?!-)/u],
  ['a date', /\b\d{4}-\d{2}-\d{2}\b/u],
  ['a session or transcript id', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/u],
  ['a task id', /\bt-[a-z0-9]{6,8}\b/u],
  ['a transcript reference', /\btranscripts?\b/iu],
];

// Two of these together read as a diagnosis of one case: a log file, a code symbol the text only
// names, narration in the past tense, or a name the record's own evidence also carries.
const SOFT: readonly (readonly [string, RegExp])[] = [
  ['a log file', /\.(?:jsonl|ndjson|log)\b/u],
  ['a code symbol', /\b[a-z]+[A-Z][A-Za-z]+\b/u],
  [
    'past-tense narration',
    /\b(?:was|were|had|did not|didn't|turned out|attributed|blamed)\b/iu,
  ],
];

const NAMES = /[\w.-]+\/[\w./-]+|\b[a-z]+[A-Z][A-Za-z]+\b/gu;

function sharesName(text: string, evidence: readonly string[]): boolean {
  const names = text.match(NAMES) ?? [];
  return names.some((name) => evidence.some((entry) => entry.includes(name)));
}

/** Judges one rule text; a refusal lists the signals so the author sees what to generalise. */
export function judgePrinciple(input: PrincipleInput): PrincipleVerdict {
  const signals = HARD.filter(([, re]) => re.test(input.text)).map(
    ([name]) => name,
  );
  if (input.enforced !== true) {
    const soft = SOFT.filter(([, re]) => re.test(input.text)).map(
      ([name]) => name,
    );
    if (sharesName(input.text, input.evidence ?? []))
      soft.push('a name its evidence also carries');
    if (soft.length >= 2) signals.push(...soft);
  }
  return signals.length === 0
    ? { principle: true }
    : { principle: false, signals };
}

/** The refusal an author reads: what was seen and what to do about it. */
export function incidentMessage(signals: readonly string[]): string {
  return `the text reads as one incident (${signals.join(', ')}); state the general principle that holds after the incident is forgotten and move the incident into the evidence`;
}

/** Every record whose text or why fails, as `id: signals`; the record-file rule test and its allowlist read this. */
export function incidentRecords(
  records: readonly {
    readonly id: string;
    readonly text: string;
    readonly why?: string;
    readonly enforcement?: { readonly kind?: string };
    readonly provenance?: { readonly evidence?: readonly string[] };
  }[],
): { readonly id: string; readonly signals: readonly string[] }[] {
  const flagged: { id: string; signals: readonly string[] }[] = [];
  for (const record of records) {
    // The reason is read beside the rule, so it must not retell the incident either.
    const signals = [record.text, record.why ?? ''].flatMap((text) => {
      const verdict = judgePrinciple({
        text,
        evidence: record.provenance?.evidence ?? [],
        enforced: record.enforcement?.kind === 'command',
      });
      return verdict.principle ? [] : verdict.signals;
    });
    if (signals.length > 0) flagged.push({ id: record.id, signals });
  }
  return flagged;
}
