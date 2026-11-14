import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * The required check run name and its GitHub App have one owner: this
 * repository's own `spec/ci-admission.json`. Ledger, admission policy and
 * adoption read the values from here; a rule test bans the literals elsewhere.
 */
const contract = z
  .object({
    schemaVersion: z.literal(1),
    checkRunName: z.string().min(1),
    appId: z.number().int().positive(),
  })
  .strict()
  .parse(
    JSON.parse(
      readFileSync(
        new URL('../../spec/ci-admission.json', import.meta.url),
        'utf8',
      ),
    ),
  );

export const REQUIRED_CHECK_NAME: string = contract.checkRunName;
export const REQUIRED_CHECK_APP_ID: number = contract.appId;
