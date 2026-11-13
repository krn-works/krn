import { z } from 'zod';

/**
 * GitHub Actions is GitHub App 15368. The base policy names the aggregate job:
 * `Check` in KRN, `ci / Check` in a repository whose workflow calls the shared
 * project CI (a reusable workflow's run is named `<caller job> / <job name>`,
 * capture: test/fixtures/ci-admission/reusable-check-runs.json).
 */
const ACTIONS_APP_ID = 15368;
const GATE_ADMISSION_POLICY_PATH = 'spec/ci-admission.json';

const sha = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u);
const admissionPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    checkRunName: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[^\p{Cc}\p{Cf}]+$/u),
    appId: z.literal(ACTIONS_APP_ID),
  })
  .strict();

export type GateAdmissionPolicy =
  | {
      readonly source: 'legacy-actions';
      readonly checkRunName: 'gate';
      readonly appSlug: 'github-actions';
    }
  | {
      readonly source: 'pinned-app';
      readonly checkRunName: string;
      readonly appId: typeof ACTIONS_APP_ID;
    };

interface GateCheckRun {
  readonly name: string;
  readonly head_sha: string;
  readonly app: {
    readonly id?: number | undefined;
    readonly slug?: string | undefined;
  } | null;
}

type GitRead = (args: string[]) => string;

const legacyActionsPolicy: GateAdmissionPolicy = {
  source: 'legacy-actions',
  checkRunName: 'gate',
  appSlug: 'github-actions',
};

/**
 * Read the admission selector from the exact leased base tree. A policy added
 * only by a PR head cannot authorize checks for that same PR.
 */
export function gateAdmissionPolicyFromBase(
  baseSha: string,
  readGit: GitRead,
): GateAdmissionPolicy {
  if (!sha.safeParse(baseSha).success)
    throw new Error('gate policy base must be a full commit ID');

  const entries = readGit([
    'ls-tree',
    '--full-tree',
    baseSha,
    '--',
    GATE_ADMISSION_POLICY_PATH,
  ])
    .split('\n')
    .filter(Boolean);
  if (entries.length === 0) return legacyActionsPolicy;
  if (entries.length !== 1)
    throw new Error('base gate policy tree entry is ambiguous');

  const match =
    /^100644 blob ([a-f\d]{40}|[a-f\d]{64})\tspec\/ci-admission\.json$/u.exec(
      entries[0] ?? '',
    );
  if (!match?.[1])
    throw new Error('base gate policy must be a regular tracked file');

  return policyFromContents(readGit(['cat-file', 'blob', match[1]]));
}

function policyFromContents(contents: string): GateAdmissionPolicy {
  if (Buffer.byteLength(contents, 'utf8') > 4096)
    throw new Error('base gate policy exceeds its size limit');
  let decoded: unknown;
  try {
    decoded = JSON.parse(contents) as unknown;
  } catch {
    throw new Error('base gate policy is invalid JSON');
  }
  const parsed = admissionPolicySchema.safeParse(decoded);
  if (!parsed.success) throw new Error('base gate policy is invalid');
  return {
    source: 'pinned-app',
    checkRunName: parsed.data.checkRunName,
    appId: ACTIONS_APP_ID,
  };
}

/**
 * The same policy read through the GitHub contents API at the exact base, for
 * a repository whose objects the local checkout does not hold. A 404 means the
 * base has no policy file.
 */
export async function gateAdmissionPolicyFromApi(
  repo: string,
  baseSha: string,
  gh: (args: string[]) => Promise<string>,
): Promise<GateAdmissionPolicy> {
  if (!sha.safeParse(baseSha).success)
    throw new Error('gate policy base must be a full commit ID');
  let body: string;
  try {
    body = await gh([
      'api',
      `repos/${repo}/contents/${GATE_ADMISSION_POLICY_PATH}?ref=${baseSha}`,
    ]);
  } catch (error) {
    if (
      /HTTP 404/u.test(
        String(Reflect.get(error as object, 'result')?.stderr ?? ''),
      )
    )
      return legacyActionsPolicy;
    throw error;
  }
  const file = z
    .object({
      type: z.literal('file'),
      encoding: z.literal('base64'),
      content: z.string(),
    })
    .safeParse(JSON.parse(body));
  if (!file.success)
    throw new Error('base gate policy must be a regular tracked file');
  return policyFromContents(
    Buffer.from(file.data.content, 'base64').toString('utf8'),
  );
}

export function matchesGateCheckRun(
  check: GateCheckRun,
  headSha: string,
  policy: GateAdmissionPolicy,
): boolean {
  if (check.name !== policy.checkRunName || check.head_sha !== headSha)
    return false;
  return policy.source === 'legacy-actions'
    ? check.app?.slug === policy.appSlug
    : check.app?.id === policy.appId;
}
