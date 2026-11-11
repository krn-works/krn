import { createPrivateKey, sign } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Mints a GitHub App installation token scoped to one repository: krn-works/krn,
// or the owner/name in KRN_APP_REPOSITORY. The App id, the krn-works/krn
// installation id and the private key come only from the local Bitwarden REST
// API (`bw serve`); another repository's installation is looked up on GitHub.
// Only the token, never the key, is cached, one cache file per repository.

export const EXIT_UNAVAILABLE = 69;
const DEFAULT_ITEM = 'KRN delivery GitHub App';
const DEFAULT_BW = 'http://localhost:8087';
const DEFAULT_API = 'https://api.github.com';
const CACHE_NAME = 'krn-app-token.json';
const DEFAULT_REPOSITORY = 'krn-works/krn';

/** owner/name of the repository the token is scoped to. */
export const REPOSITORY_VARIABLE = 'KRN_APP_REPOSITORY';

function targetRepository(env: Env): { owner: string; name: string } {
  const value = env[REPOSITORY_VARIABLE] || DEFAULT_REPOSITORY;
  const match = /^([A-Za-z0-9][\w.-]*)\/([\w.-]+)$/u.exec(value);
  if (!match?.[1] || !match[2])
    throw new Unavailable(`${REPOSITORY_VARIABLE} is not owner/name: ${value}`);
  return { owner: match[1], name: match[2] };
}
const REUSE_MARGIN_SECONDS = 300;

/** The launcher raises the margin so a cached token outlives the whole session it starts. */
export const REUSE_MARGIN_VARIABLE = 'KRN_APP_REUSE_MARGIN_SECONDS';

function reuseMarginSeconds(env: Env): number {
  const value = Number(env[REUSE_MARGIN_VARIABLE]);
  return Number.isInteger(value) && value > 0 ? value : REUSE_MARGIN_SECONDS;
}

export class Unavailable extends Error {}

type Env = NodeJS.ProcessEnv;
type Cached = { token: string; expires_at: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

export function appJwt(appId: string, privateKey: string, now: number) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
  );
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(`${header}.${claims}`),
    createPrivateKey(privateKey),
  );
  return `${header}.${claims}.${base64url(signature)}`;
}

function cachePath(env: Env): string | undefined {
  // The sandbox hides XDG_RUNTIME_DIR, so the launcher names a cache
  // directory the sandbox can read.
  const directory = env.KRN_APP_CACHE_DIR || env.XDG_RUNTIME_DIR;
  if (!directory) return undefined;
  const { owner, name } = targetRepository(env);
  const file =
    `${owner}/${name}` === DEFAULT_REPOSITORY
      ? CACHE_NAME
      : `krn-app-token.${owner}.${name}.json`;
  return join(directory, file);
}

function readCache(env: Env, now: number): string | undefined {
  const path = cachePath(env);
  if (!path) return undefined;
  try {
    const cached = record(JSON.parse(readFileSync(path, 'utf8')));
    const token = cached?.token;
    const expires = Date.parse(String(cached?.expires_at));
    if (
      typeof token === 'string' &&
      token &&
      expires - now * 1000 > reuseMarginSeconds(env) * 1000
    )
      return token;
  } catch {
    // no usable cache: mint again
  }
  return undefined;
}

function writeCache(env: Env, value: Cached): void {
  const path = cachePath(env);
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {
    // a cache that cannot be written only costs a mint
  }
}

type Credential = { appId: string; installationId: string; key: string };

async function readCredential(env: Env): Promise<Credential> {
  const base = (env.KRN_BW_SERVE || DEFAULT_BW).replace(/\/+$/u, '');
  const name = env.KRN_APP_ITEM || DEFAULT_ITEM;
  let body: unknown;
  try {
    const response = await fetch(
      `${base}/list/object/items?search=${encodeURIComponent(name)}`,
    );
    if (!response.ok) throw new Error(`status ${response.status}`);
    body = await response.json();
  } catch {
    throw new Unavailable(`bw serve unavailable at ${base}`);
  }
  const items = record(record(record(body)?.data))?.data;
  const item = Array.isArray(items)
    ? items.map(record).find((candidate) => candidate?.name === name)
    : undefined;
  if (!item) throw new Unavailable(`Bitwarden item "${name}" not found`);
  const fields = new Map<string, string>();
  if (Array.isArray(item.fields))
    for (const field of item.fields) {
      const entry = record(field);
      if (typeof entry?.name === 'string' && typeof entry.value === 'string')
        fields.set(entry.name, entry.value);
    }
  const appId = fields.get('app_id');
  const installationId = fields.get('installation_id');
  if (!appId) throw new Unavailable(`item "${name}" lacks field app_id`);
  if (!installationId)
    throw new Unavailable(`item "${name}" lacks field installation_id`);
  const key = typeof item.notes === 'string' ? item.notes : '';
  if (!key.includes('PRIVATE KEY'))
    throw new Unavailable(`item "${name}" lacks the private key in its notes`);
  return { appId, installationId, key };
}

// GET /repos/{owner}/{repo}/installation answers the App's installation on
// that repository (capture: test/fixtures/github-app-token/repo-installation.txt).
async function repositoryInstallation(
  api: string,
  headers: Record<string, string>,
  owner: string,
  name: string,
): Promise<string> {
  let id: unknown;
  try {
    const response = await fetch(
      `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
      { headers },
    );
    if (!response.ok) throw new Error(`status ${response.status}`);
    id = record(await response.json())?.id;
  } catch (error) {
    throw new Unavailable(
      `the App is not installed on ${owner}/${name} (${error instanceof Error ? error.message : 'error'})`,
    );
  }
  if (typeof id !== 'number')
    throw new Unavailable(
      `GitHub answered no installation id for ${owner}/${name}`,
    );
  return String(id);
}

export async function mintToken(
  env: Env,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const cached = readCache(env, now);
  if (cached) return cached;
  // A lane session is sandboxed away from bw serve: the launcher mints the token before
  // the session, so a miss there fails closed instead of reaching for the vault.
  if (env.KRN_SESSION_CLASS === 'lane')
    throw new Unavailable(
      'no cached App token in a lane session (the launcher mints it before the session)',
    );
  const { appId, installationId, key } = await readCredential(env);
  let jwt: string;
  try {
    jwt = appJwt(appId, key, now);
  } catch {
    throw new Unavailable('the private key in the Bitwarden item is unusable');
  }
  const api = (env.KRN_GITHUB_API || DEFAULT_API).replace(/\/+$/u, '');
  const headers = {
    authorization: `Bearer ${jwt}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'krn-app-token',
    'x-github-api-version': '2022-11-28',
  };
  const { owner, name } = targetRepository(env);
  const installation =
    `${owner}/${name}` === DEFAULT_REPOSITORY
      ? installationId
      : await repositoryInstallation(api, headers, owner, name);
  let reply: Record<string, unknown> | undefined;
  try {
    const response = await fetch(
      `${api}/app/installations/${encodeURIComponent(installation)}/access_tokens`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ repositories: [name] }),
      },
    );
    if (!response.ok) throw new Error(`status ${response.status}`);
    reply = record(await response.json());
  } catch (error) {
    throw new Unavailable(
      `GitHub refused the installation token (${error instanceof Error ? error.message : 'error'})`,
    );
  }
  const token = reply?.token;
  const expires = reply?.expires_at;
  if (typeof token !== 'string' || typeof expires !== 'string')
    throw new Unavailable('GitHub answered without a token');
  writeCache(env, { token, expires_at: expires });
  return token;
}

function credentialRequest(input: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const line of input.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) pairs.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  return pairs;
}

const USAGE =
  'usage: github-app-token.ts token | git-credential get|store|erase';

export async function main(
  args: string[],
  env: Env,
  readStdin: () => string,
  out: (text: string) => void,
): Promise<number> {
  const [verb, action] = args;
  if (verb === 'token' && args.length === 1) {
    out(`${await mintToken(env)}\n`);
    return 0;
  }
  if (verb === 'git-credential' && args.length === 2) {
    if (action === 'store' || action === 'erase') return 0;
    if (action === 'get') {
      const request = credentialRequest(readStdin());
      if (request.get('host') !== 'github.com') return 0;
      const token = await mintToken(env);
      out(`username=x-access-token\npassword=${token}\n`);
      return 0;
    }
  }
  process.stderr.write(`${USAGE}\n`);
  return 64;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = await main(
      process.argv.slice(2),
      process.env,
      () => {
        try {
          return readFileSync(0, 'utf8');
        } catch {
          return '';
        }
      },
      (text) => process.stdout.write(text),
    );
  } catch (error) {
    if (!(error instanceof Unavailable)) throw error;
    process.stderr.write(`github-app-token: ${error.message}\n`);
    process.exitCode = EXIT_UNAVAILABLE;
  }
}
