import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, openSync, writeSync } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliUsageError } from '../cli/usage-error.ts';
import {
  codexScopeRuntimeProperties,
  drainSystemdScope,
  killAndVerifyScope,
  spawnSystemdScope,
  systemdScopeUnit,
} from '../hosts/systemd-scope.ts';
import { EvalDataError, loadManifest } from './manifest.ts';
import { credentialMounts } from './mask.ts';
import { planExperiment } from './plan.ts';
import { type Harness, SessionUsage } from './usage.ts';

// These bytes (including the pinned model) are hashed as the session's config.
// Empty config homes plus the mask remove ambient MCP, skills and history.
export const CODEX_CONFIG = `approval_policy = "never"
sandbox_mode = "workspace-write"
cli_auth_credentials_store = "file"
web_search = "disabled"
[history]
persistence = "none"
[features]
apps = false
plugins = false
remote_plugin = false
skill_search = false
skill_mcp_dependency_install = false
browser_use = false
browser_use_external = false
browser_use_full_cdp_access = false
computer_use = false
image_generation = false
hooks = false
memories = false
`;
export const CLAUDE_SETTINGS = `${JSON.stringify(
  {
    disableAllHooks: true,
    autoMemoryEnabled: false,
    enableAllProjectMcpServers: false,
    enabledMcpjsonServers: [],
    permissions: {
      allow: [
        'Read(//w/repo/**)',
        'Edit(//w/repo/**)',
        'Write(//w/repo/**)',
        'Bash(*)',
      ],
      deny: [
        'Skill',
        'Read(//w/codex/**)',
        'Read(//w/claude/**)',
        'Edit(//w/codex/**)',
        'Edit(//w/claude/**)',
        'Write(//w/codex/**)',
        'Write(//w/claude/**)',
      ],
      additionalDirectories: ['/w/repo'],
    },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: ['/w/repo', '/w/t'],
        denyRead: ['/w/codex', '/w/claude'],
      },
      network: { allowedDomains: [] },
    },
  },
  null,
  2,
)}\n`;

const usage =
  'usage: krn eval session --experiment <dir> --root <dir> --run <runId> --slot <dir> --prompt-file <file> [--timeout <seconds>] [--draft] [--json]';
const digest = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

function options(args: string[]) {
  const values = new Map<string, string>();
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (
      !arg ||
      ![
        '--experiment',
        '--root',
        '--run',
        '--slot',
        '--prompt-file',
        '--timeout',
        '--draft',
        '--json',
      ].includes(arg)
    )
      throw new CliUsageError(`unknown session option ${arg}; ${usage}`);
    if (seen.has(arg)) throw new CliUsageError(`${arg} may be supplied once`);
    seen.add(arg);
    if (arg === '--draft' || arg === '--json') continue;
    const value = args[++index];
    if (!value || value.startsWith('--'))
      throw new CliUsageError(`missing value for ${arg}; ${usage}`);
    values.set(arg, value);
  }
  function required(name: string) {
    const value = values.get(name);
    if (!value) throw new CliUsageError(usage);
    return value;
  }
  const timeout = Number(values.get('--timeout') ?? '1800');
  if (
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    !Number.isSafeInteger(timeout * 1000) ||
    timeout * 1000 > 2_147_483_647
  )
    throw new EvalDataError(
      'timeout must be positive integer seconds within the timer limit',
    );
  return {
    experiment: required('--experiment'),
    root: required('--root'),
    slot: required('--slot'),
    run: required('--run'),
    prompt: required('--prompt-file'),
    draft: seen.has('--draft'),
    json: seen.has('--json'),
    timeoutMs: timeout * 1000,
  };
}

function inside(path: string, parent: string) {
  const child = relative(parent, path);
  return (
    child === '' ||
    (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
  );
}
function overlaps(left: string, right: string) {
  return inside(left, right) || inside(right, left);
}

// Inspect before normalization: even `symlink/../directory` must be refused.
async function inspect(
  path: string,
  kind: 'file' | 'directory',
  missing = false,
): Promise<string> {
  if (!isAbsolute(path) || path.includes('\0') || path.includes('\\'))
    throw new EvalDataError(`invalid absolute ${kind} path: ${path}`);
  let current = '/';
  const parts = path.slice(1).split('/');
  for (const [index, part] of parts.entries()) {
    if (!part || part === '.' || part === '..')
      throw new EvalDataError(
        `path must not contain empty or dot segments: ${path}`,
      );
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new EvalDataError(`path must not contain symlinks: ${current}`);
      const file = index === parts.length - 1 && kind === 'file';
      if (file ? !stat.isFile() : !stat.isDirectory())
        throw new EvalDataError(
          `expected ${file ? 'regular file' : 'directory'}: ${current}`,
        );
    } catch (error) {
      if (
        !(
          missing &&
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        )
      )
        throw error;
    }
  }
  return current;
}

async function absent(path: string) {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return;
    throw error;
  }
  throw new EvalDataError(`session requires fresh output and config: ${path}`);
}

async function executable(harness: Harness): Promise<string> {
  const override =
    process.env[
      harness === 'codex' ? 'KRN_EVAL_CODEX_BIN' : 'KRN_EVAL_CLAUDE_BIN'
    ];
  const candidates =
    override === undefined
      ? (process.env.PATH ?? '')
          .split(':')
          .map((path) => resolve(path || '.', harness))
      : [override];
  if (override !== undefined && !isAbsolute(override))
    throw new EvalDataError('harness executable override must be absolute');
  for (const candidate of candidates) {
    try {
      // PATH executables commonly are symlinks. Bind their actual installation,
      // never their parent home or an operator's config directory.
      const path = await realpath(candidate);
      if (!(await lstat(path)).isFile()) continue;
      await access(path, constants.X_OK);
      return path;
    } catch {
      /* Try the next PATH entry. */
    }
  }
  throw new EvalDataError(`cannot resolve executable for ${harness}`);
}

export async function sessionCommand(args: string[]): Promise<void> {
  const input = options(args);
  const manifest = await loadManifest(input.experiment);
  const run = planExperiment(manifest, input).runs.find(
    (run) => run.runId === input.run,
  );
  if (!run) throw new EvalDataError(`unknown run id: ${input.run}`);
  const arm = manifest.arms.find((arm) => arm.id === run.arm);
  if (!arm || (arm.harness !== 'codex' && arm.harness !== 'claude'))
    throw new EvalDataError(`unknown harness: ${arm?.harness}`);
  const harness = arm.harness;
  const configName = harness === 'codex' ? 'config.toml' : 'settings.json';
  const credentialName =
    harness === 'codex' ? 'auth.json' : '.credentials.json';
  const config =
    harness === 'codex'
      ? `model = ${JSON.stringify(arm.model)}\n${CODEX_CONFIG}`
      : CLAUDE_SETTINGS;
  let slot: string,
    output: string,
    prompt: Buffer,
    binary: string,
    credential: string;
  try {
    const experiment = await inspect(resolve(input.experiment), 'directory');
    const root = await inspect(input.root, 'directory');
    slot = await inspect(input.slot, 'directory');
    await inspect(join(slot, 'repo'), 'directory');
    await inspect(input.prompt, 'file');
    prompt = await readFile(input.prompt);
    // Prompts are UTF-8; BOM and CRLF are preserved and hashed as raw bytes.
    new TextDecoder('utf-8', { fatal: true }).decode(prompt);
    output = join(root, manifest.id, 'runs', run.runId);
    for (const target of [root, join(root, manifest.id), output]) {
      if (overlaps(target, experiment) || inside(target, slot))
        throw new EvalDataError(
          'session root/output overlaps experiment or slot',
        );
    }
    if (
      inside(slot, join(root, manifest.id, 'runs')) ||
      overlaps(output, slot) ||
      overlaps(slot, experiment)
    )
      throw new EvalDataError(
        'session evidence and experiment must be outside every slot',
      );
    for (const ancestor of [root, join(root, manifest.id), dirname(output)]) {
      try {
        await lstat(join(ancestor, 'repo'));
        throw new EvalDataError(
          `session evidence root is another slot: ${ancestor}`,
        );
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
        )
          throw error;
      }
    }
    await inspect(output, 'directory', true);
    await absent(output);
    for (const name of ['codex', 'claude']) await absent(join(slot, name));
    const home = process.env.HOME;
    if (!home)
      throw new EvalDataError('HOME is required to locate the login file');
    credential = `${join(home, `.${harness}`, credentialName)}=/w/${harness}/${credentialName}`;
    await credentialMounts([credential], slot);
    binary = await executable(harness);
    const tools = [...new Set([dirname(binary), dirname(process.execPath)])];
    for (const tool of tools) {
      if (
        tool === '/' ||
        overlaps(tool, slot) ||
        overlaps(tool, experiment) ||
        overlaps(tool, root) ||
        inside(home, tool) ||
        overlaps(tool, join(home, '.codex')) ||
        overlaps(tool, join(home, '.claude'))
      )
        throw new EvalDataError(
          `tool directory overlaps protected session paths: ${tool}`,
        );
    }
    // Validate every destination before the first write.
    await mkdir(dirname(output), { recursive: true });
    await mkdir(output);
    await mkdir(join(slot, harness));
    await writeFile(join(slot, harness, configName), config, {
      flag: 'wx',
      mode: 0o444,
    });
  } catch (error) {
    if (error instanceof EvalDataError) throw error;
    throw new EvalDataError(
      `session input: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const command =
    harness === 'codex'
      ? [
          binary,
          'exec',
          '--json',
          '--ephemeral',
          '--model',
          arm.model,
          '--sandbox',
          'workspace-write',
          '--cd',
          '/w/repo',
          '--color',
          'never',
          '-',
        ]
      : [
          binary,
          '-p',
          '--permission-mode',
          'acceptEdits',
          '--model',
          arm.model,
          '--output-format',
          'stream-json',
          '--verbose',
          '--no-session-persistence',
          '--session-id',
          randomUUID(),
          '--strict-mcp-config',
          '--settings',
          '/w/claude/settings.json',
        ];
  const maskArgs = [
    fileURLToPath(new URL('../cli/main.ts', import.meta.url)),
    'eval',
    'mask',
    '--slot',
    slot,
    '--network',
    ...[...new Set([dirname(binary), dirname(process.execPath)])].flatMap(
      (path) => ['--tool', path],
    ),
    '--credential',
    credential,
    '--credential',
    `${join(slot, harness, configName)}=/w/${harness}/${configName}`,
    '--',
    '/usr/bin/env',
    `${harness === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'}=/w/${harness}`,
    ...command,
  ];
  const startedAt = new Date().toISOString();
  const scope = systemdScopeUnit('eval-session');
  const accounting = new SessionUsage(harness);
  let timedOut = false;
  let exitCode = 70;
  let launchError = false;
  const stdout = openSync(join(output, 'stream.jsonl'), 'wx');
  const stderr = openSync(join(output, 'stderr.log'), 'wx');
  try {
    const child = spawnSystemdScope(scope, process.execPath, maskArgs, {
      stdio: ['pipe', 'pipe', stderr],
      systemdProperties: codexScopeRuntimeProperties(input.timeoutMs),
    });
    let stop: Promise<void> | undefined;
    const terminate = () => {
      stop ??= killAndVerifyScope(scope).finally(() => child.kill('SIGKILL'));
      return stop;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void terminate().catch(() => {
        launchError = true;
      });
    }, input.timeoutMs);
    const cancel = () => {
      void terminate().catch(() => {
        launchError = true;
      });
    };
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
      child.stdout?.on('data', (bytes: Buffer) => {
        writeSync(stdout, bytes);
        accounting.push(bytes);
      });
      child.stdin?.on('error', () => {
        /* Early harness refusal can close stdin. */
      });
      child.stdin?.end(prompt);
      exitCode = await new Promise<number>((resolveExit) => {
        child.once('error', (error) => {
          launchError = true;
          writeSync(stderr, `${error.message}\n`);
        });
        child.once('close', (code, signal) => {
          clearTimeout(timer);
          resolveExit(
            code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 70),
          );
        });
      });
      if (stop) await stop;
      await drainSystemdScope(scope);
    } finally {
      clearTimeout(timer);
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
  } catch (error) {
    launchError = true;
    writeSync(
      stderr,
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  accounting.finish();
  if (timedOut) exitCode = 124;
  else if (launchError) exitCode = 70;
  const status = accounting.configRejected
    ? 'harness_error'
    : timedOut
      ? 'timeout'
      : launchError
        ? 'harness_error'
        : exitCode !== 0 || accounting.error
          ? exitCode !== 0 && accounting.error && !accounting.toolCalled
            ? 'harness_error'
            : 'agent_error'
          : accounting.truncated
            ? 'truncated'
            : 'completed';
  const session = {
    runId: run.runId,
    arm: run.arm,
    harness,
    model: arm.model,
    configSha256: digest(config),
    promptSha256: digest(prompt),
    startedAt,
    endedAt: new Date().toISOString(),
    exitCode,
    status,
    ...(accounting.configRejected ? { reason: 'config_rejected' } : {}),
    usage: accounting.summary(timedOut || launchError),
    scope,
  };
  await writeFile(
    join(output, 'calls.jsonl'),
    accounting.calls.map((call) => `${JSON.stringify(call)}\n`).join(''),
    { flag: 'wx' },
  );
  await writeFile(
    join(output, 'session.json'),
    `${JSON.stringify(session, null, 2)}\n`,
    { flag: 'wx' },
  );
  process.stdout.write(
    input.json
      ? `${JSON.stringify({ ok: true, ...session }, null, 2)}\n`
      : `${run.runId}: ${status}\n`,
  );
  process.exitCode = exitCode;
}
