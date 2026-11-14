// Command router: one table keyed by the owned commands of help.ts; each command loads on demand.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type CommandName, isCommand } from './help.ts';

function productRoot(): string {
  return realpathSync(fileURLToPath(new URL('../..', import.meta.url))).replace(
    /\/$/u,
    '',
  );
}

type Handler = (options: string[]) => Promise<void> | void;

async function doctor(options: string[]): Promise<void> {
  let report: { text: string; exitCode: number };
  if (options.includes('--unattended')) {
    const { unattendedReport } = await import('./doctor-unattended.ts');
    report = unattendedReport(options);
  } else {
    const pin = await import('./entry-pin.ts');
    report = pin.doctorReport(pin.configuredEntryRoot());
    const host = await import('./doctor-host.ts');
    const facts = host.hostReport(host.readHostFacts(productRoot()));
    report = {
      text: report.text + facts.text,
      exitCode: report.exitCode || facts.exitCode,
    };
  }
  process.stdout.write(report.text);
  process.exitCode = report.exitCode;
}

async function task(options: string[]): Promise<void> {
  if (process.env.KRN_FORWARDED !== undefined) {
    // The host entry forwarded this call: refuse a stale or unpinned build.
    const pin = await import('./entry-pin.ts');
    const state = pin.readEntryPin(productRoot());
    if (pin.isUnfetched(state)) {
      process.stderr.write(pin.unfetchedWarning(state));
    } else if (!pin.isFresh(state)) {
      process.stderr.write(pin.staleEntryMessage(state));
      process.exitCode = pin.staleEntryExit;
      return;
    }
  }
  const { taskCommand } = await import('../task/cli.ts');
  await taskCommand(options);
}

// Typed by CommandName, so a command without help text or a help entry without a handler fails tsc.
const commands: Record<CommandName, Handler> = {
  ledger: async (options) =>
    (await import('./ledger.ts')).ledgerCommand(options),
  ci: async (options) => (await import('./ci.ts')).ciCommand(options),
  pr: async (options) => (await import('./pr.ts')).prCommand(options),
  task,
  lane: async (options) =>
    options[0] === 'run'
      ? (await import('./lane-run-verb.ts')).laneRunVerb(options.slice(1))
      : (await import('./lane.ts')).laneCommand(options),
  state: async (options) => (await import('./state.ts')).stateCommand(options),
  decide: async (options) =>
    (await import('./decide.ts')).decideCommand(options),
  findings: async (options) =>
    (await import('./findings.ts')).findingsCommand(options),
  plan: async (options) => (await import('./plan.ts')).planCommand(options),
  repo: async (options) => (await import('./repo.ts')).repoCommand(options),
  hook: async (options) =>
    (await import('./hook.ts')).hookCommand(options, productRoot()),
  adopt: async (options) => (await import('./adopt.ts')).adoptCommand(options),
  doctor,
  standards: async (options) =>
    (await import('../brain/standards-cli.ts')).standardsCommand(options),
};

export async function dispatch(args: string[]): Promise<boolean> {
  const [command, ...options] = args;
  if (!isCommand(command)) return false;
  await commands[command](options);
  return true;
}
