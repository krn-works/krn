import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { appCredentialEnvironment } from '../../scripts/claude/successor-launch.ts';
import {
  captureReply,
  installAgent,
  installHerdr,
  ok,
  readCalls,
} from '../helpers/herdr-stub.ts';

const helper = fileURLToPath(
  new URL('../../scripts/github-app-token.ts', import.meta.url),
);
const launcher = fileURLToPath(
  new URL('../../scripts/claude/successor-launch.ts', import.meta.url),
);
const ITEM = 'KRN delivery GitHub App';
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
) => void;

async function serve(t: { after(fn: () => void): void }, handler: Handler) {
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => handler(req, res, body));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

type Fakes = {
  env: Record<string, string>;
  github: { requests: { url: string; auth: string; body: string }[] };
  minted: () => number;
  runtime: string;
};

async function fakes(
  t: { after(fn: () => void): void },
  options: { items?: unknown[]; expiresIn?: number } = {},
): Promise<Fakes> {
  const requests: Fakes['github']['requests'] = [];
  let count = 0;
  const items = options.items ?? [
    { name: 'KRN delivery GitHub App (old)', notes: 'x', fields: [] },
    {
      name: ITEM,
      notes: pem,
      fields: [
        { name: 'app_id', value: '4242' },
        { name: 'installation_id', value: '77' },
      ],
    },
  ];
  const bw = await serve(t, (req, res) => {
    assert.match(req.url ?? '', /^\/list\/object\/items\?search=/u);
    json(res, { success: true, data: { data: items } });
  });
  const github = await serve(t, (req, res, body) => {
    count += 1;
    requests.push({
      url: req.url ?? '',
      auth: String(req.headers.authorization),
      body,
    });
    json(
      res,
      {
        token: `ghs_token${count}`,
        expires_at: new Date(
          Date.now() + (options.expiresIn ?? 3600) * 1000,
        ).toISOString(),
      },
      201,
    );
  });
  const runtime = mkdtempSync(join(tmpdir(), 'app-token-'));
  t.after(() => rmSync(runtime, { recursive: true, force: true }));
  return {
    env: {
      KRN_BW_SERVE: bw,
      KRN_GITHUB_API: github,
      XDG_RUNTIME_DIR: runtime,
      KRN_APP_CACHE_DIR: runtime,
    },
    github: { requests },
    minted: () => count,
    runtime,
  };
}

function exec(
  file: string,
  args: string[],
  env: Record<string, string>,
  input = '',
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = execFile(
      process.execPath,
      [file, ...args],
      { env: { PATH: process.env.PATH ?? '', ...env } },
      (error, stdout, stderr) =>
        done({
          code: error ? Number((error as { code?: number }).code) : 0,
          stdout,
          stderr,
        }),
    );
    child.stdin?.end(input);
  });
}

test('the token request carries a verifiable RS256 JWT and names the repository', async (t) => {
  const f = await fakes(t);
  const before = Math.floor(Date.now() / 1000);
  const result = await exec(helper, ['token'], f.env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'ghs_token1\n');
  const [request] = f.github.requests;
  assert.ok(request);
  assert.equal(request.url, '/app/installations/77/access_tokens');
  assert.deepEqual(JSON.parse(request.body), { repositories: ['krn'] });
  const jwt = request.auth.replace(/^Bearer /u, '');
  const [header, claims, signature] = jwt.split('.');
  assert.ok(header && claims && signature);
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), {
    alg: 'RS256',
    typ: 'JWT',
  });
  const payload = JSON.parse(Buffer.from(claims, 'base64url').toString());
  assert.equal(payload.iss, '4242');
  assert.equal(payload.exp - payload.iat, 600);
  assert.ok(Math.abs(payload.iat - (before - 60)) <= 5);
  assert.ok(
    verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${claims}`),
      publicKey,
      Buffer.from(signature, 'base64url'),
    ),
  );
  assert.ok(!result.stdout.includes('PRIVATE KEY'));
});

test('git-credential get answers only for github.com and store/erase do nothing', async (t) => {
  const f = await fakes(t);
  const got = await exec(
    helper,
    ['git-credential', 'get'],
    f.env,
    'protocol=https\nhost=github.com\n\n',
  );
  assert.equal(got.code, 0, got.stderr);
  assert.equal(got.stdout, 'username=x-access-token\npassword=ghs_token1\n');
  const other = await exec(
    helper,
    ['git-credential', 'get'],
    f.env,
    'protocol=https\nhost=example.com\n\n',
  );
  assert.deepEqual([other.code, other.stdout], [0, '']);
  for (const action of ['store', 'erase']) {
    const result = await exec(
      helper,
      ['git-credential', action],
      f.env,
      'protocol=https\nhost=github.com\npassword=x\n\n',
    );
    assert.deepEqual([result.code, result.stdout], [0, '']);
  }
  assert.equal(f.minted(), 1);
});

test('the token is cached 0600 without the key, reused, and re-minted near expiry', async (t) => {
  const f = await fakes(t);
  assert.equal((await exec(helper, ['token'], f.env)).stdout, 'ghs_token1\n');
  assert.equal((await exec(helper, ['token'], f.env)).stdout, 'ghs_token1\n');
  assert.equal(f.minted(), 1);
  const path = join(f.runtime, 'krn-app-token.json');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(!readFileSync(path, 'utf8').includes('PRIVATE KEY'));

  // Inside the five-minute margin the cache is not reused.
  writeFileSync(
    path,
    JSON.stringify({
      token: 'ghs_old',
      expires_at: new Date(Date.now() + 200_000).toISOString(),
    }),
  );
  assert.equal((await exec(helper, ['token'], f.env)).stdout, 'ghs_token2\n');
  assert.equal(f.minted(), 2);
});

test('a raised reuse margin re-mints a cache that a session could outlive', async (t) => {
  const f = await fakes(t);
  await exec(helper, ['token'], f.env);
  const path = join(f.env.KRN_APP_CACHE_DIR as string, 'krn-app-token.json');
  writeFileSync(
    path,
    JSON.stringify({
      token: 'ghs_old',
      expires_at: new Date(Date.now() + 1_800_000).toISOString(),
    }),
  );
  assert.equal((await exec(helper, ['token'], f.env)).stdout, 'ghs_old\n');
  const raised = { ...f.env, KRN_APP_REUSE_MARGIN_SECONDS: '3000' };
  assert.equal((await exec(helper, ['token'], raised)).stdout, 'ghs_token2\n');
});

test('without XDG_RUNTIME_DIR nothing is cached', async (t) => {
  const f = await fakes(t);
  const { XDG_RUNTIME_DIR: _x, KRN_APP_CACHE_DIR: _c, ...env } = f.env;
  await exec(helper, ['token'], env);
  await exec(helper, ['token'], env);
  assert.equal(f.minted(), 2);
});

test('the cache directory named by the launcher serves a helper without XDG_RUNTIME_DIR', async (t) => {
  const f = await fakes(t);
  await exec(helper, ['token'], f.env);
  const { XDG_RUNTIME_DIR: _x, ...sandboxed } = f.env;
  assert.equal(
    (await exec(helper, ['token'], sandboxed)).stdout,
    'ghs_token1\n',
  );
  assert.equal(f.minted(), 1);
  assert.equal(
    appCredentialEnvironment({ PATH: '/b' }, '/h', '/w', '/c/cache')
      .KRN_APP_CACHE_DIR,
    '/c/cache',
  );
});

test('an unavailable bw serve or item exits 69 with one line naming the piece', async (t) => {
  const f = await fakes(t);
  const down = await exec(helper, ['token'], {
    ...f.env,
    KRN_BW_SERVE: 'http://127.0.0.1:9',
  });
  assert.equal(down.code, 69);
  assert.match(
    down.stderr,
    /^github-app-token: bw serve unavailable at .+\n$/u,
  );

  const missing = await exec(helper, ['token'], {
    ...f.env,
    KRN_APP_ITEM: 'no such item',
  });
  assert.equal(missing.code, 69);
  assert.match(
    missing.stderr,
    /^github-app-token: Bitwarden item "no such item" not found\n$/u,
  );

  const bare = await fakes(t, {
    items: [
      { name: ITEM, notes: pem, fields: [{ name: 'app_id', value: '1' }] },
    ],
  });
  const lacking = await exec(helper, ['token'], bare.env);
  assert.equal(lacking.code, 69);
  assert.match(lacking.stderr, /lacks field installation_id/u);
  assert.ok(
    ![down, missing, lacking].some((r) => r.stderr.includes(pem.slice(40, 80))),
  );
  const credential = await exec(
    helper,
    ['git-credential', 'get'],
    {
      ...f.env,
      KRN_BW_SERVE: 'http://127.0.0.1:9',
    },
    'host=github.com\n',
  );
  assert.equal(credential.code, 69);
});

test('the gh wrapper runs the real gh with the minted token and does not recurse', async (t) => {
  const f = await fakes(t);
  const root = mkdtempSync(join(tmpdir(), 'app-gh-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, 'real');
  mkdirSync(real);
  writeFileSync(
    join(real, 'gh'),
    '#!/bin/sh\necho "token=$GH_TOKEN args=$*"\n',
    {
      mode: 0o755,
    },
  );
  const wrapperDir = fileURLToPath(
    new URL('../../scripts/app-bin', import.meta.url),
  );
  const out = await new Promise<{ code: number; stdout: string }>((done) =>
    execFile(
      join(wrapperDir, 'gh'),
      ['pr', 'list'],
      {
        env: {
          ...f.env,
          PATH: `${wrapperDir}:${real}:${join(process.execPath, '..')}:/usr/bin:/bin`,
        },
      },
      (error, stdout) =>
        done({
          code: error ? Number((error as { code?: number }).code) : 0,
          stdout,
        }),
    ),
  );
  assert.deepEqual(out, { code: 0, stdout: 'token=ghs_token1 args=pr list\n' });
});

test('the launcher environment resets the helper list before installing the helper', () => {
  const env = appCredentialEnvironment(
    { PATH: '/usr/bin' },
    '/r/helper.ts',
    '/r/app-bin',
  );
  assert.equal(env.PATH, '/r/app-bin:/usr/bin');
  assert.equal(env.GIT_CONFIG_COUNT, '2');
  assert.equal(env.GIT_CONFIG_KEY_0, 'credential.https://github.com.helper');
  assert.equal(env.GIT_CONFIG_VALUE_0, '');
  assert.equal(env.GIT_CONFIG_KEY_1, 'credential.https://github.com.helper');
  assert.match(
    env.GIT_CONFIG_VALUE_1 ?? '',
    /^!'.+' '\/r\/helper\.ts' git-credential$/u,
  );
  const stacked = appCredentialEnvironment(
    {
      PATH: '/b',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: '*',
    },
    '/h',
    '/w',
  );
  assert.equal(stacked.GIT_CONFIG_COUNT, '3');
  assert.equal(stacked.GIT_CONFIG_KEY_0, 'safe.directory');
  assert.equal(stacked.GIT_CONFIG_VALUE_0, '*');
  assert.equal(
    stacked.GIT_CONFIG_KEY_1,
    'credential.https://github.com.helper',
  );
});

async function launch(
  t: { after(fn: () => void): void },
  args: string[],
  env: Record<string, string>,
) {
  const root = mkdtempSync(join(tmpdir(), 'app-launch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const calls = installHerdr(bin, {
    status: captureReply('server-status.txt'),
    'tab create': captureReply('tab-create.reply.jsonl'),
    'pane run': ok(''),
    'agent get': captureReply('agent-get-working-claude.reply.jsonl'),
  });
  installAgent(bin, 'claude', join(root, 'agent-calls'));
  const result = await new Promise<{ code: number; stderr: string }>((done) =>
    execFile(
      process.execPath,
      [
        launcher,
        '--name',
        'n',
        '--prompt',
        'p',
        '--cwd',
        root,
        '--start-seconds',
        '1',
        ...args,
      ],
      {
        cwd: root,
        env: {
          PATH: bin,
          KRN_SUCCESSOR_AGENT: 'claude',
          ...env,
        },
      },
      (error, _stdout, stderr) =>
        done({
          code: error ? Number((error as { code?: number }).code) : 0,
          stderr,
        }),
    ),
  );
  const create =
    readCalls(calls).find((c) => c[0] === 'tab' && c[1] === 'create') ?? [];
  return { ...result, create };
}

test('a launched session gets the App credential unless --operator-token is passed', async (t) => {
  const f = await fakes(t);
  const withApp = await launch(t, [], f.env);
  assert.equal(withApp.code, 0, withApp.stderr);
  const pairs = withApp.create.filter((_, i, all) => all[i - 1] === '--env');
  assert.ok(
    pairs.some((p) => p.startsWith('PATH=') && p.includes('scripts/app-bin:')),
  );
  assert.ok(pairs.includes('GIT_CONFIG_COUNT=2'));
  assert.ok(
    pairs.includes('GIT_CONFIG_KEY_0=credential.https://github.com.helper'),
  );
  assert.ok(pairs.includes('GIT_CONFIG_VALUE_0='));
  assert.ok(pairs.some((p) => p.startsWith('GIT_CONFIG_VALUE_1=!')));
  assert.ok(!pairs.some((p) => p.includes('ghs_token')));
  assert.equal(f.minted(), 1);

  const operator = await launch(t, ['--operator-token'], f.env);
  assert.equal(operator.code, 0, operator.stderr);
  const operatorPairs = operator.create.filter(
    (_, i, all) => all[i - 1] === '--env',
  );
  assert.ok(
    !operatorPairs.some(
      (p) => p.startsWith('GIT_CONFIG') || p.startsWith('PATH='),
    ),
  );
  assert.equal(f.minted(), 1);
});

test('the launcher refuses with exit 69 naming the flag when no token can be minted', async (t) => {
  const f = await fakes(t);
  const refused = await launch(t, [], {
    ...f.env,
    KRN_BW_SERVE: 'http://127.0.0.1:9',
  });
  assert.equal(refused.code, 69);
  assert.match(refused.stderr, /bw serve unavailable.*--operator-token/u);
  assert.deepEqual(refused.create, []);
});

test('a lane session serves the cached token and fails closed on a miss without calling bw serve', async (t) => {
  const f = await fakes(t);
  await exec(helper, ['token'], f.env);
  const lane = { ...f.env, KRN_SESSION_CLASS: 'lane' };
  assert.equal((await exec(helper, ['token'], lane)).stdout, 'ghs_token1\n');
  const credential = await exec(
    helper,
    ['git-credential', 'get'],
    lane,
    'host=github.com\n',
  );
  assert.match(credential.stdout, /password=ghs_token1\n/u);
  assert.equal(f.minted(), 1);

  // Cache gone and bw serve reachable: the lane still must not mint.
  rmSync(join(f.runtime, 'krn-app-token.json'));
  const miss = await exec(helper, ['token'], lane);
  assert.equal(miss.code, 69);
  assert.match(miss.stderr, /no cached App token in a lane session/u);
  assert.equal(f.minted(), 1);
});
