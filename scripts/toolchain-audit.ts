// Read-only audit of the workstation toolchain against the workstation skill's rule: one mise
// version per tool, the newest stable, pinned the same in every project.
// Usage: node scripts/toolchain-audit.ts --root DIR [--root DIR...]
// Prints one finding per line, then `toolchain PASS` (exit 0) or `toolchain FAIL (...)` (exit 1).
import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export type Installed = Record<
  string,
  { version: string; active?: boolean; source?: { path: string } }[]
>;
export type Outdated = {
  tool: string;
  current: string;
  latest: string;
  source: string;
};
export type FilePin = { file: string; tool: string; version: string };
export type AuditInput = {
  installed: Installed;
  outdated: Outdated[];
  filePins: FilePin[];
  latest: Record<string, string>;
  pathHits: Record<string, string[]>;
  tempConfigs: string[];
  foreignInstalls: string[];
  errors: string[];
};
export type Finding = {
  kind:
    | 'outdated'
    | 'multi'
    | 'backend'
    | 'path'
    | 'tracking'
    | 'foreign'
    | 'error';
  line: string;
};

/** The tool name without its backend: `npm:playwright` and `aqua:a/mago` give `playwright` and `mago`; a scoped npm name stays whole. */
export function shortName(tool: string): string {
  const bare = tool.includes(':') ? tool.slice(tool.indexOf(':') + 1) : tool;
  if (bare.startsWith('@')) return bare;
  return bare.split('/').at(-1) ?? bare;
}

export function audit(input: AuditInput): Finding[] {
  const findings: Finding[] = [];
  for (const o of input.outdated)
    findings.push({
      kind: 'outdated',
      line: `outdated ${o.source} ${o.tool} ${o.current} -> ${o.latest}`,
    });
  for (const pin of input.filePins) {
    const latest = input.latest[pin.tool];
    if (latest !== undefined && latest !== pin.version)
      findings.push({
        kind: 'outdated',
        line: `outdated ${pin.file} ${pin.tool} ${pin.version} -> ${latest}`,
      });
  }
  const byName = new Map<string, string[]>();
  for (const [tool, versions] of Object.entries(input.installed)) {
    const present = versions.map((v) => v.version);
    if (present.length > 1) {
      const active = versions.filter((v) => v.active).map((v) => v.version);
      findings.push({
        kind: 'multi',
        line: `multi ${tool} ${present.join(' ')} (active ${active.join(' ') || 'none'})`,
      });
    }
    const name = shortName(tool);
    byName.set(name, [...(byName.get(name) ?? []), tool]);
  }
  for (const [name, tools] of byName)
    if (tools.length > 1)
      findings.push({
        kind: 'backend',
        line: `backend ${name} installed as ${tools.sort().join(', ')}`,
      });
  for (const [name, paths] of Object.entries(input.pathHits))
    findings.push({
      kind: 'path',
      line: `path ${name} also outside mise: ${paths.join(', ')}`,
    });
  if (input.tempConfigs.length > 0)
    findings.push({
      kind: 'tracking',
      line: `tracking ${input.tempConfigs.length} temporary configs keep versions from mise prune (e.g. ${input.tempConfigs[0]})`,
    });
  // An install directory that resolves outside mise exposes that directory's binaries as shims
  // (a link to /usr made mise shim all of /usr/bin, git included).
  for (const f of input.foreignInstalls)
    findings.push({ kind: 'foreign', line: `foreign ${f}` });
  for (const e of input.errors)
    findings.push({ kind: 'error', line: `error ${e}` });
  return findings;
}

export function verdict(findings: Finding[]): string {
  if (findings.length === 0) return 'toolchain PASS';
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  const parts = [...counts].map(([kind, n]) => `${n} ${kind}`);
  return `toolchain FAIL (${parts.join(', ')})`;
}

const SKIP = new Set([
  'node_modules',
  '.git',
  'vendor',
  '.krn',
  '.cache',
  'dist',
]);
const MISE_FILES = [
  'mise.toml',
  '.mise.toml',
  'mise.local.toml',
  '.tool-versions',
];
const IDIOMATIC: Record<string, string> = {
  '.node-version': 'node',
  '.nvmrc': 'node',
  '.python-version': 'python',
};
const TEMP = /\/tmp\/|\/\.krn\/runs\/|\/scratchpad\//u;

function projectDirs(root: string, depth: number, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return; // unreadable directory: nothing of ours lives there
  }
  const marks = [...MISE_FILES, ...Object.keys(IDIOMATIC), 'package.json'];
  if (entries.some((e) => marks.includes(e))) out.push(root);
  if (depth === 0) return;
  for (const e of entries) {
    if (SKIP.has(e)) continue;
    const path = join(root, e);
    try {
      if (statSync(path).isDirectory()) projectDirs(path, depth - 1, out);
    } catch {
      // dangling link: skip it
    }
  }
}

function mise(args: string[], cwd: string): string {
  return execFileSync('mise', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

type OutdatedEntry = {
  current: string | null;
  latest: string;
  bump: string | null;
  requested: string;
  source: { path: string };
};

function outdatedIn(
  dir: string,
  inside: (path: string) => boolean,
): Outdated[] {
  const raw = JSON.parse(mise(['outdated', '--bump', '--json'], dir)) as Record<
    string,
    OutdatedEntry
  >;
  return Object.entries(raw)
    .filter(([, e]) => e.current !== null && inside(e.source.path))
    .map(([tool, e]) => ({
      tool,
      current: e.requested === 'latest' ? (e.current ?? '') : e.requested,
      latest: e.bump ?? e.latest,
      source: e.source.path,
    }));
}

function collect(roots: string[]): AuditInput {
  const home = homedir();
  const errors: string[] = [];
  const installed = JSON.parse(
    mise(['ls', '--installed', '--json'], home),
  ) as Installed;
  const outdated = outdatedIn(home, () => true);
  const dirs: string[] = [];
  for (const root of roots) projectDirs(root, 5, dirs);
  const filePins: FilePin[] = [];
  for (const dir of dirs) {
    // Only a project that pins through mise is ours to align; third-party clones keep their own pins.
    if (!MISE_FILES.some((f) => existsSync(join(dir, f)))) continue;
    try {
      outdated.push(...outdatedIn(dir, (p) => p.startsWith(`${dir}${sep}`)));
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      errors.push(
        `${dir}: ${text.split('\n').find((l) => l.trim()) ?? 'mise failed'}`,
      );
    }
    for (const [file, tool] of Object.entries(IDIOMATIC)) {
      const path = join(dir, file);
      if (existsSync(path))
        filePins.push({
          file: path,
          tool,
          version: readFileSync(path, 'utf8').trim().replace(/^v/u, ''),
        });
    }
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      const manager = /"packageManager"\s*:\s*"pnpm@([^"+]+)/u.exec(
        readFileSync(pkg, 'utf8'),
      )?.[1];
      if (manager !== undefined)
        filePins.push({
          file: `${pkg} packageManager`,
          tool: 'pnpm',
          version: manager,
        });
    }
  }
  const latest: Record<string, string> = {};
  for (const tool of new Set(filePins.map((p) => p.tool)))
    latest[tool] = mise(['latest', tool], home).trim();
  const miseData = process.env.MISE_DATA_DIR ?? join(home, '.local/share/mise');
  const names = new Set(Object.keys(installed).map(shortName));
  if (names.has('node')) for (const n of ['npm', 'npx']) names.add(n);
  // The distribution's own python stays: Arch system packages depend on it.
  names.delete('python');
  const pathHits: Record<string, string[]> = {};
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const name of names) {
    const hits = new Set<string>();
    for (const d of pathDirs) {
      if (d.startsWith(miseData)) continue;
      const path = join(d, name);
      try {
        accessSync(path, constants.X_OK);
        // A link into mise (e.g. ~/.local/bin/codex -> the shim) is mise's copy, not a duplicate.
        const target = lstatSync(path).isSymbolicLink()
          ? resolve(dirname(path), readlinkSync(path))
          : realpathSync(path);
        if (!target.startsWith(miseData)) hits.add(path);
      } catch {
        // not in this PATH directory
      }
    }
    if (hits.size > 0) pathHits[name] = [...hits];
  }
  const state = process.env.MISE_STATE_DIR ?? join(home, '.local/state/mise');
  const tracked = join(state, 'tracked-configs');
  const tempConfigs: string[] = [];
  if (existsSync(tracked))
    for (const link of readdirSync(tracked)) {
      try {
        const target = readlinkSync(join(tracked, link));
        if (TEMP.test(target) && existsSync(target)) tempConfigs.push(target);
      } catch {
        // not a link: mise wrote something else here
      }
    }
  const installs = join(miseData, 'installs');
  const foreignInstalls: string[] = [];
  if (existsSync(installs))
    for (const tool of readdirSync(installs).filter((t) =>
      statSync(join(installs, t)).isDirectory(),
    ))
      for (const version of readdirSync(join(installs, tool))) {
        const path = join(installs, tool, version);
        try {
          const target = realpathSync(path);
          if (!target.startsWith(`${miseData}${sep}`))
            foreignInstalls.push(`${tool}/${version} -> ${target}`);
        } catch {
          // dangling alias link: mise repairs it on the next install
        }
      }
  return {
    installed,
    outdated,
    filePins,
    latest,
    pathHits,
    tempConfigs,
    foreignInstalls,
    errors,
  };
}

function main(argv: string[]): number {
  const roots: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const root = argv[i + 1];
    if (argv[i] !== '--root' || root === undefined) {
      console.error('usage: toolchain-audit.ts --root DIR [--root DIR...]');
      return 64;
    }
    roots.push(root);
    i += 1;
  }
  if (roots.length === 0) {
    console.error('usage: toolchain-audit.ts --root DIR [--root DIR...]');
    return 64;
  }
  const findings = audit(collect(roots));
  for (const f of findings) console.log(f.line);
  const line = verdict(findings);
  console.log(line);
  return line === 'toolchain PASS' ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  process.exitCode = main(process.argv.slice(2));
