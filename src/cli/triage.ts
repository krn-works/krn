import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';

export const help = `krn triage [--log FILE | --ci-run ID --repo OWNER/REPO] [--head SHA] [--base SHA]
  --base-log FILE  Output of the same tests at base
  --out DIR        Brief directory (default .krn/runs/triage/<head12>-<UTCstamp>/)
  --json           Print triage.json instead of one verdict line
Exit codes: 0 confirmed or failed-at-base; 66 insufficient; 64 usage.
`;
export async function triageCommand(args: string[]): Promise<void> {
  try {
    const { values } = parseArgs({
      args,
      options: {
        log: { type: 'string' },
        'ci-run': { type: 'string' },
        repo: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
        'base-log': { type: 'string' },
        out: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    });
    if (values.help) {
      process.stdout.write(help);
      return;
    }
    const sha = z
      .string()
      .regex(/^[a-f\d]{40}$/iu)
      .optional();
    const parsed = z
      .object({
        log: z.string().min(1).optional(),
        ciRun: z.string().regex(/^\d+$/u).optional(),
        repo: z
          .string()
          .regex(/^[A-Za-z\d][A-Za-z\d_.-]*\/[A-Za-z\d][A-Za-z\d_.-]*$/u)
          .optional(),
        head: sha,
        base: sha,
        baseLog: z.string().min(1).optional(),
        out: z.string().min(1).optional(),
      })
      .refine(
        (v) => !(v.log && v.ciRun) && Boolean(v.ciRun) === Boolean(v.repo),
      )
      .safeParse({
        log: values.log,
        ciRun: values['ci-run'],
        repo: values.repo,
        head: values.head,
        base: values.base,
        baseLog: values['base-log'],
        out: values.out,
      });
    if (!parsed.success) throw new Error('Invalid triage arguments');
    const { triage } = await import('../triage/index.ts');
    // Only present properties cross the exact-optional adapter boundary.
    const options = Object.fromEntries(
      Object.entries(parsed.data).filter(([, value]) => value !== undefined),
    );
    const result = await triage(options);
    const { readFileSync } = await import('node:fs');
    process.stdout.write(
      values.json
        ? readFileSync(join(dirname(result.brief), 'triage.json'), 'utf8')
        : `triage: ${result.verdict} ${result.class} ${result.brief}\n`,
    );
    process.exitCode = result.exitCode;
  } catch {
    // Raw parser, filesystem and transport failures can contain credentials.
    process.stderr.write(
      `Invalid triage input or unable to write brief.\n${help}`,
    );
    process.exitCode = 64;
  }
}
