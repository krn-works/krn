import {
  type Dirent,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type Stats,
  statSync,
} from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { git, gitAvailable } from './git.ts';

export function normalizeRunPointer(root: string, pointer: string): string {
  // Resolve symlink aliases so one physical run reached by two names has one
  // identity; a missing pointer falls back to its normalized lexical path.
  const absolute = resolve(root, pointer);
  let resolved = absolute;
  try {
    resolved = realpathSync(absolute);
  } catch {
    resolved = absolute;
  }
  return posixRelative(root, resolved);
}

/** The file name a capsule's cleanup entry points at to cover every run the file lists, one pointer per line. */
export const RUN_INDEX_FILE = 'run-index.md';

/**
 * The runs a capsule's cleanup entries cover: each entry's own pointer plus the
 * pointers listed in any run index file an entry names. A directory pointer
 * covers only itself, never the runs beneath it. Check and resume both read
 * the list through this function.
 */
export function listedRunPointers(
  root: string,
  entryPointers: string[],
): { covered: Set<string>; indexes: Set<string> } {
  const covered = new Set<string>();
  const indexes = new Set<string>();
  for (const pointer of entryPointers) {
    const normalized = normalizeRunPointer(root, pointer);
    covered.add(normalized);
    if (basename(normalized) !== RUN_INDEX_FILE) continue;
    let text: string;
    try {
      text = readFileSync(resolve(root, pointer), 'utf8');
    } catch {
      continue;
    }
    indexes.add(normalized);
    for (const line of text.split('\n')) {
      const listed = line.trim();
      if (listed !== '' && !listed.startsWith('#'))
        covered.add(normalizeRunPointer(root, listed));
    }
  }
  return { covered, indexes };
}

export interface Finding {
  id?: string;
  rule: string;
  detail: string;
}

export function isInside(parent: string, candidate: string): boolean {
  const root = resolve(parent);
  const rel = relative(root, resolve(root, candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..');
}

export function posixRelative(base: string, file: string): string {
  return relative(base, file).split(sep).join('/');
}

export function resolveRepositoryRoot(repo: string): {
  root: string;
  hasGit: boolean;
} {
  const requested = resolve(repo);
  const stat = statSync(requested, { throwIfNoEntry: false });
  if (!stat) throw new Error(`repository path does not exist: ${requested}`);
  if (!stat.isDirectory())
    throw new Error(
      `state expects a repository directory, got a file: ${requested}`,
    );
  const hasGit = gitAvailable();
  const top = hasGit
    ? git(requested, ['rev-parse', '--show-toplevel'])
    : { ok: false, out: '' };
  return { root: top.ok && top.out ? resolve(top.out) : requested, hasGit };
}

interface RunDirectory {
  workflow: string;
  pointer: string;
}

export function runDirectoriesDetailed(root: string): {
  runs: RunDirectory[];
  errors: string[];
} {
  const runsBase = join(root, '.krn', 'runs');
  if (!existsSync(runsBase)) return { runs: [], errors: [] };
  const runs: RunDirectory[] = [];
  const errors: string[] = [];
  let workflows: Dirent[];
  try {
    workflows = readdirSync(runsBase, { withFileTypes: true });
  } catch {
    return { runs: [], errors: ['.krn/runs could not be listed'] };
  }
  for (const workflow of workflows.sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (
      (!workflow.isDirectory() && !workflow.isSymbolicLink()) ||
      workflow.name === 'delivery-loop'
    )
      continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(join(runsBase, workflow.name), {
        withFileTypes: true,
      });
    } catch {
      errors.push(`${join('.krn', 'runs', workflow.name)} could not be listed`);
      continue;
    }
    for (const run of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!run.isDirectory() && !run.isSymbolicLink()) continue;
      runs.push({
        workflow: workflow.name,
        pointer: join('.krn', 'runs', workflow.name, run.name),
      });
    }
  }
  return { runs, errors };
}

interface CapsuleStoreEntry {
  id: string;
  link: boolean;
  kind?: 'resolve';
  resolvedDirectory?: string;
  error?: { rule: string; detail: string };
  state?: { relativePath: string; resolvedRelativePath: string; text: string };
}

export function capsuleStoreReport(root: string): {
  storeErrors: { rule: string; detail: string }[];
  entries: CapsuleStoreEntry[];
} {
  const base = join(root, '.krn', 'runs', 'delivery-loop');
  const storeErrors: { rule: string; detail: string }[] = [];
  const storeError = (detail: string) => {
    storeErrors.push({ rule: 'unreadable-capsule-store', detail });
    return { storeErrors, entries: [] };
  };
  const listFail = '.krn/runs/delivery-loop could not be listed';
  let present: Stats | undefined;
  try {
    present = lstatSync(base, { throwIfNoEntry: false });
  } catch {
    return storeError(listFail);
  }
  if (!present) return { storeErrors, entries: [] };
  let target: Stats | undefined;
  try {
    target = statSync(base, { throwIfNoEntry: false });
  } catch {
    return storeError(listFail);
  }
  if (!target) return storeError('.krn/runs/delivery-loop is a broken symlink');
  if (!target.isDirectory())
    return storeError('.krn/runs/delivery-loop is not a directory');
  let raw: Dirent[];
  try {
    raw = readdirSync(base, { withFileTypes: true });
  } catch {
    return storeError(listFail);
  }
  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {
    // keep the lexical root
  }
  const entries: CapsuleStoreEntry[] = [];
  for (const entry of raw) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const directory = join(base, entry.name);
    const relativePath = `.krn/runs/delivery-loop/${entry.name}/state.md`;
    const link = entry.isSymbolicLink();
    const id = entry.name;
    let real: string;
    try {
      real = realpathSync(directory);
    } catch {
      entries.push({ id, link, kind: 'resolve' });
      continue;
    }
    try {
      if (!statSync(real).isDirectory()) continue;
    } catch {
      continue;
    }
    const withError = (rule: string, detail: string) =>
      entries.push({
        id,
        link,
        resolvedDirectory: real,
        error: { rule, detail },
      });
    if (!isInside(realRoot, real)) {
      withError('capsule-outside-repo', real);
      continue;
    }
    const file = join(directory, 'state.md');
    const unreadable = (detail = relativePath) =>
      withError('unreadable-capsule', detail);
    let filePresent: Stats | undefined;
    try {
      filePresent = lstatSync(file, { throwIfNoEntry: false });
    } catch {
      unreadable();
      continue;
    }
    if (!filePresent) {
      withError('capsule-state-missing', relativePath);
      continue;
    }
    let fileStat: Stats | undefined;
    try {
      fileStat = statSync(file, { throwIfNoEntry: false });
    } catch {
      unreadable();
      continue;
    }
    if (!fileStat) {
      unreadable(`${relativePath} is a broken symlink`);
      continue;
    }
    if (!fileStat.isFile()) {
      unreadable(`${relativePath} is not a regular file`);
      continue;
    }
    let resolvedState: string;
    try {
      resolvedState = realpathSync(file);
    } catch {
      unreadable();
      continue;
    }
    if (!isInside(realRoot, resolvedState)) {
      withError('capsule-outside-repo', resolvedState);
      continue;
    }
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      unreadable();
      continue;
    }
    entries.push({
      id,
      link,
      resolvedDirectory: real,
      state: {
        relativePath,
        resolvedRelativePath: posixRelative(realRoot, resolvedState),
        text,
      },
    });
  }
  return { storeErrors, entries };
}
