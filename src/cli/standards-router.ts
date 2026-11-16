// `krn standards <verb>`: the one router. The verb table (names, usage, help) is
// src/brain/standards-verbs.ts; this module binds one handler to each name, and the type
// requires every verb of the table to have one.

import {
  isStandardsVerb,
  type StandardsVerb,
  usage,
} from '../brain/standards-verbs.ts';
import { CliUsageError } from '../cli-kit/usage-error.ts';

type Handler = (rest: string[]) => void | Promise<void>;

const brain = () => import('../brain/standards-cli.ts');

const handlers: Record<StandardsVerb, Handler> = {
  check: async (rest) =>
    rest.includes('--tasks')
      ? (await import('./standards-tasks.ts')).checkWithTasks(rest)
      : (await brain()).checkCommand(rest),
  install: async (rest) => (await brain()).installCommand(rest),
  propose: async (rest) => (await brain()).proposeCommand(rest),
  harvest: async (rest) =>
    rest.includes('--from-ledger')
      ? (await import('./standards-ledger.ts')).harvestLedgerCommand(rest)
      : (await brain()).harvestCommand(rest),
  effect: async (rest) => (await brain()).effectCommand(rest),
  retire: async (rest) => (await brain()).retireCommand(rest),
  review: async (rest) => (await brain()).reviewCommand(rest),
  query: async (rest) => (await brain()).queryCommand(rest),
};

export async function standardsCommand(args: string[]): Promise<void> {
  const [verb, ...rest] = args;
  if (!isStandardsVerb(verb)) throw new CliUsageError(usage);
  await handlers[verb](rest);
}
