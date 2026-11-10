import { createPrivateKey, sign } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Mints a GitHub App installation token for krn-works/krn. The App id,
// installation id and private key come only from the local Bitwarden REST API
// (`bw serve`); only the token, never the key, is cached.

export const EXIT_UNAVAILABLE = 69;
const DEFAULT_ITEM = 'KRN delivery GitHub App';
const DEFAULT_BW = 'http://localhost:8087';
const DEFAULT_API = 'https://api.github.com';
const CACHE_NAME = 'krn-app-token.json';
const REUSE_MARGIN_SECONDS = 300;

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
  // The sandbox scrubs XDG_RUNTIME_DIR, so the launcher names the directory
  // of its mint again in a variable that survives.
  const directory = env.KRN_APP_CACHE_DIR || env.XDG_RUNTIME_DIR;
  return directory ? join(directory, CACHE_NAME) : undefined;
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
      expires - now * 1000 > REUSE_MARGIN_SECONDS * 1000
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

export async function mintToken(
  env: Env,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const cached = readCache(env, now);
  if (cached) return cached;
  const { appId, installationId, key } = await readCredential(env);
  let jwt: string;
  try {
    jwt = appJwt(appId, key, now);
  } catch {
    throw new Unavailable('the private key in the Bitwarden item is unusable');
  }
  const api = (env.KRN_GITHUB_API || DEFAULT_API).replace(/\/+$/u, '');
  let reply: Record<string, unknown> | undefined;
  try {
    const response = await fetch(
      `${api}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${jwt}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'user-agent': 'krn-app-token',
          'x-github-api-version': '2022-11-28',
        },
        body: JSON.stringify({ repositories: ['krn'] }),
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
