import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
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
import { writeCache } from '../../src/ci/app-token.ts';
import { appCredentialEnvironment } from '../../src/successor/compose.ts';
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

// Bodies from the verbatim capture of GET /repos/{owner}/{repo}/installation.
const captured = readFileSync(
  new URL(
    '../fixtures/github-app-token/repo-installation.txt',
    import.meta.url,
  ),
  'utf8',
)
  .split('\n')
  .filter((line) => line.startsWith('{'))
  .map((line) => JSON.parse(line) as Record<string, unknown>);
const capturedInstallation = {
  present: captured[0] ?? {},
  absent: captured[1] ?? {},
};

/** A stub installation token with the real shape: ghs_ plus 36 alphanumerics. */
function stubToken(label: string): string {
  return `ghs_${label.padStart(36, 'x')}`;
}

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
    requests.push({
      url: req.url ?? '',
      auth: String(req.headers.authorization),
      body,
    });
    const lookup = /^\/repos\/([^/]+)\/([^/]+)\/installation$/u.exec(
      req.url ?? '',
    );
    if (lookup) {
      const [status, answer] =
        lookup[2] === 'absent'
          ? [404, capturedInstallation.absent]
          : [200, capturedInstallation.present];
      json(res, answer, status);
      return;
    }
    count += 1;
    json(
      res,
      {
        token: stubToken(`token${count}`),
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
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = execFile(
      process.execPath,
      [file, ...args],
      {
        env: { PATH: process.env.PATH ?? '', ...env },
        ...(cwd ? { cwd } : {}),
      },
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
  assert.equal(result.stdout, `${stubToken('token1')}\n`);
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
  assert.equal(
    got.stdout,
    `username=x-access-token\npassword=${stubToken('token1')}\n`,
  );
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
  assert.equal(
    (await exec(helper, ['token'], f.env)).stdout,
    `${stubToken('token1')}\n`,
  );
  assert.equal(
    (await exec(helper, ['token'], f.env)).stdout,
    `${stubToken('token1')}\n`,
  );
  assert.equal(f.minted(), 1);
  const path = join(f.runtime, 'krn-app-token.json');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(!readFileSync(path, 'utf8').includes('PRIVATE KEY'));

  // Inside the five-minute margin the cache is not reused.
  writeFileSync(
    path,
    JSON.stringify({
      token: stubToken('old'),
      expires_at: new Date(Date.now() + 200_000).toISOString(),
    }),
  );
  assert.equal(
    (await exec(helper, ['token'], f.env)).stdout,
    `${stubToken('token2')}\n`,
  );
  assert.equal(f.minted(), 2);
});

test('a raised reuse margin re-mints a cache that a session could outlive', async (t) => {
  const f = await fakes(t);
  await exec(helper, ['token'], f.env);
  const path = join(f.env.KRN_APP_CACHE_DIR as string, 'krn-app-token.json');
  writeFileSync(
    path,
    JSON.stringify({
      token: stubToken('old'),
      expires_at: new Date(Date.now() + 1_800_000).toISOString(),
    }),
  );
  assert.equal(
    (await exec(helper, ['token'], f.env)).stdout,
    `${stubToken('old')}\n`,
  );
  const raised = { ...f.env, KRN_APP_REUSE_MARGIN_SECONDS: '3000' };
  assert.equal(
    (await exec(helper, ['token'], raised)).stdout,
    `${stubToken('token2')}\n`,
  );
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
    `${stubToken('token1')}\n`,
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
  assert.deepEqual(out, {
    code: 0,
    stdout: `token=${stubToken('token1')} args=pr list\n`,
  });
});

test('the gh wrapper scopes its token to -R, else to the checkout origin', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'app-gh-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, 'real');
  mkdirSync(real);
  writeFileSync(join(real, 'gh'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
  const wrapperDir = fileURLToPath(
    new URL('../../scripts/app-bin', import.meta.url),
  );
  const run = (args: string[], env: Record<string, string>, cwd: string) =>
    new Promise<number>((done) =>
      execFile(
        join(wrapperDir, 'gh'),
        args,
        {
          cwd,
          env: {
            ...env,
            PATH: `${wrapperDir}:${real}:${join(process.execPath, '..')}:/usr/bin:/bin`,
          },
        },
        (error) => done(error ? Number((error as { code?: number }).code) : 0),
      ),
    );
  const pilot = checkoutWithOrigin(
    t,
    'git@github.com:pilot-owner/pilot-repo.git',
  );
  const byOrigin = await fakes(t);
  assert.equal(await run(['pr', 'list'], byOrigin.env, pilot), 0);
  assert.equal(
    byOrigin.github.requests[0]?.url,
    '/repos/pilot-owner/pilot-repo/installation',
  );
  // A second checkout's wrapper earlier on PATH is skipped, not exec'd back and forth.
  const twin = join(root, 'twin');
  mkdirSync(twin);
  copyFileSync(join(wrapperDir, 'gh'), join(twin, 'gh'));
  chmodSync(join(twin, 'gh'), 0o755);
  const twinned = await fakes(t);
  const twinRun = await new Promise<string>((done) =>
    execFile(
      join(wrapperDir, 'gh'),
      ['pr', 'list'],
      {
        cwd: pilot,
        timeout: 20000,
        env: {
          ...twinned.env,
          PATH: `${twin}:${wrapperDir}:${real}:${join(process.execPath, '..')}:/usr/bin:/bin`,
        },
      },
      (_error, stdout) => done(stdout),
    ),
  );
  assert.equal(twinRun, 'ok\n');
  const byFlag = await fakes(t);
  assert.equal(
    await run(
      ['pr', 'list', '-R', 'github.com/flag-owner/flag-repo'],
      byFlag.env,
      pilot,
    ),
    0,
  );
  assert.equal(
    byFlag.github.requests[0]?.url,
    '/repos/flag-owner/flag-repo/installation',
  );
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

test('the launcher environment never stacks helper pairs across generations', () => {
  const gitEntries = (env: Record<string, string | undefined>) =>
    Array.from(
      { length: Number(env.GIT_CONFIG_COUNT) },
      (_, i) => `${env[`GIT_CONFIG_KEY_${i}`]}=${env[`GIT_CONFIG_VALUE_${i}`]}`,
    );
  let env: Record<string, string | undefined> = {
    PATH: '/b',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: '*',
  };
  for (let generation = 0; generation < 5; generation += 1)
    env = { ...env, ...appCredentialEnvironment(env, '/h', '/w') };
  const entries = gitEntries(env);
  assert.equal(entries.length, 3);
  assert.equal(entries[0], 'safe.directory=*');
  assert.equal(
    entries.filter((entry) =>
      entry.startsWith('credential.https://github.com.helper='),
    ).length,
    2,
  );
  assert.equal(entries[1], 'credential.https://github.com.helper=');
  assert.deepEqual(
    gitEntries(appCredentialEnvironment(env, '/h', '/w')),
    entries,
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
  assert.ok(!pairs.some((p) => p.includes('ghs_')));
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
  assert.equal(
    (await exec(helper, ['token'], lane)).stdout,
    `${stubToken('token1')}\n`,
  );
  const credential = await exec(
    helper,
    ['git-credential', 'get'],
    lane,
    'host=github.com\n',
  );
  assert.equal(
    credential.stdout,
    `username=x-access-token\npassword=${stubToken('token1')}\n`,
  );
  assert.equal(f.minted(), 1);

  // Cache gone and bw serve reachable: the lane still must not mint.
  rmSync(join(f.runtime, 'krn-app-token.json'));
  const miss = await exec(helper, ['token'], lane);
  assert.equal(miss.code, 69);
  assert.match(miss.stderr, /no cached App token in a lane session/u);
  assert.equal(f.minted(), 1);
});

test('KRN_APP_REPOSITORY scopes the token to that repository through its own installation', async (t) => {
  const f = await fakes(t);
  const env = { ...f.env, KRN_APP_REPOSITORY: 'pilot-owner/pilot-repo' };
  const result = await exec(helper, ['token'], env);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    f.github.requests.map((request) => request.url),
    [
      '/repos/pilot-owner/pilot-repo/installation',
      `/app/installations/${capturedInstallation.present.id}/access_tokens`,
    ],
  );
  assert.deepEqual(JSON.parse(f.github.requests[1]?.body ?? ''), {
    repositories: ['pilot-repo'],
  });
  // The pilot token never answers for krn-works/krn, nor the reverse.
  const krn = await exec(helper, ['token'], f.env);
  assert.equal(krn.stdout, `${stubToken('token2')}\n`);
  assert.equal(
    (await exec(helper, ['token'], env)).stdout,
    `${stubToken('token1')}\n`,
  );
  assert.equal(f.minted(), 2);
});

/** A git checkout whose origin is `url`, so the helper can read the repository git runs in. */
function checkoutWithOrigin(t: { after(fn: () => void): void }, url: string) {
  const dir = mkdtempSync(join(tmpdir(), 'app-origin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', url]);
  return dir;
}

test('git-credential get scopes the token to the repository git asks for, not krn-works/krn', async (t) => {
  const pilotLookup = '/repos/pilot-owner/pilot-repo/installation';
  // git sends path= when credential.useHttpPath is set: the path names the repository.
  const byPath = await fakes(t);
  const fromPath = await exec(
    helper,
    ['git-credential', 'get'],
    { ...byPath.env, KRN_APP_REPOSITORY: 'krn-works/krn' },
    'protocol=https\nhost=github.com\npath=pilot-owner/pilot-repo.git\n\n',
  );
  assert.equal(fromPath.code, 0, fromPath.stderr);
  assert.equal(byPath.github.requests[0]?.url, pilotLookup);
  // Without path= and without KRN_APP_REPOSITORY, the checkout git runs in names it by its origin.
  const byOrigin = await fakes(t);
  const fromOrigin = await exec(
    helper,
    ['git-credential', 'get'],
    byOrigin.env,
    'protocol=https\nhost=github.com\n\n',
    checkoutWithOrigin(t, 'https://github.com/pilot-owner/pilot-repo.git'),
  );
  assert.equal(fromOrigin.code, 0, fromOrigin.stderr);
  assert.equal(byOrigin.github.requests[0]?.url, pilotLookup);
  // KRN_APP_REPOSITORY (a lane's own origin) still wins over the checkout's origin.
  const byEnv = await fakes(t);
  await exec(
    helper,
    ['git-credential', 'get'],
    { ...byEnv.env, KRN_APP_REPOSITORY: 'pilot-owner/pilot-repo' },
    'protocol=https\nhost=github.com\n\n',
    checkoutWithOrigin(t, 'https://github.com/other-owner/other-repo.git'),
  );
  assert.equal(byEnv.github.requests[0]?.url, pilotLookup);
});

test('a repository without the App or a malformed KRN_APP_REPOSITORY exits 69 naming it', async (t) => {
  const f = await fakes(t);
  const absent = await exec(helper, ['token'], {
    ...f.env,
    KRN_APP_REPOSITORY: 'pilot-owner/absent',
  });
  assert.equal(absent.code, 69);
  assert.match(
    absent.stderr,
    /^github-app-token: the App is not installed on pilot-owner\/absent \(status 404\)\n$/u,
  );
  const malformed = await exec(helper, ['token'], {
    ...f.env,
    KRN_APP_REPOSITORY: 'no-slash',
  });
  assert.equal(malformed.code, 69);
  assert.match(
    malformed.stderr,
    /KRN_APP_REPOSITORY is not owner\/name: no-slash/u,
  );
  assert.equal(f.minted(), 0);
});

test('a planted non-installation token in the cache is discarded and never written', async (t) => {
  const f = await fakes(t);
  const path = join(f.runtime, 'krn-app-token.json');
  writeFileSync(
    path,
    JSON.stringify({
      token: 'abc123',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }),
  );
  const result = await exec(helper, ['token'], f.env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `${stubToken('token1')}\n`);
  assert.match(result.stderr, /discarded a cached token/u);
  assert.equal(f.minted(), 1);

  rmSync(path);
  writeCache(f.env, {
    token: 'abc123',
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  assert.equal(existsSync(path), false);
});

test('a short ghs_ token planted in the cache is discarded and replaced by a fresh mint', async (t) => {
  const f = await fakes(t);
  const path = join(f.env.KRN_APP_CACHE_DIR as string, 'krn-app-token.json');
  writeFileSync(
    path,
    JSON.stringify({
      token: 'ghs_token12',
      expires_at: '2027-01-15T00:00:00.000Z',
    }),
  );
  const result = await exec(helper, ['token'], f.env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `${stubToken('token1')}\n`);
  assert.equal(f.minted(), 1);
  assert.equal(
    JSON.parse(readFileSync(path, 'utf8')).token,
    stubToken('token1'),
  );
});

test('a current-format installation token (390 characters with . _ -) is cached and served to a lane session', async (t) => {
  const f = await fakes(t);
  const path = join(f.env.KRN_APP_CACHE_DIR as string, 'krn-app-token.json');
  // Shape of the token GitHub minted for krn-works/seo-audit-harness on 2026-11-17: ghs_, 386 characters, 3 '-',
  // 2 '.', 2 '_' (the classic 40-character regex refused to cache it and every pilot lane preflight failed).
  const token = `ghs_${'A1b2'.repeat(48)}-x.y_z-${'C3d4'.repeat(46)}.e_f-g`;
  assert.ok(token.length > 380);
  writeCache(f.env, {
    token,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).token, token);
  const lane = await exec(helper, ['token'], {
    ...f.env,
    KRN_SESSION_CLASS: 'lane',
  });
  assert.equal(lane.code, 0, lane.stderr);
  assert.equal(lane.stdout, `${token}\n`);
  assert.equal(f.minted(), 0);
});
