import { RerunError, rerun } from '../ci/rerun.ts';

const usage = 'Usage: krn ci rerun --pr <n> --head <sha> [--repo <owner/repo>]';

export async function ciCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== 'rerun') throw new RerunError(usage, 64);
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index] ?? '';
    const value = rest[index + 1];
    if (
      !['--pr', '--head', '--repo'].includes(key) ||
      value === undefined ||
      options.has(key)
    )
      throw new RerunError(
        `Invalid or repeated option ${key.slice(0, 40)}; ${usage}`,
        64,
      );
    options.set(key, value);
  }
  const pr = options.get('--pr');
  const head = options.get('--head');
  if (pr === undefined || head === undefined) throw new RerunError(usage, 64);
  const repo = options.get('--repo');
  const line = await rerun({
    pr: /^\d+$/u.test(pr) ? Number(pr) : Number.NaN,
    head,
    ...(repo === undefined ? {} : { repo }),
  });
  process.stdout.write(`${line}\n`);
}
