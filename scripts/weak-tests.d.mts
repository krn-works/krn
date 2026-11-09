export function checkWeakTests(input: {
  diff: string;
  body?: string;
  targetExists: (stem: string) => boolean;
}): { ok: boolean; overridden: boolean; findings: string[] };
