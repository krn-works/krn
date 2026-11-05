import { createHash } from 'node:crypto';
import { lstatSync, opendirSync, readdirSync, readlinkSync } from 'node:fs';
import { join, parse, resolve } from 'node:path';
import { git } from './git.ts';
import { isMissing, readBytes, WorkerError } from './state.ts';

export function gitMetadataBaseline(repo: string) {
  const roots = [
    ...new Set([
      git(repo, 'rev-parse', '--path-format=absolute', '--git-dir').trim(),
      git(
        repo,
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ).trim(),
    ]),
  ];
  // Other lanes fetch and push through the shared common directory during a
  // turn; remote-tracking refs are theirs, local branches stay protected.
  const remoteRefs = new Set(
    roots.map((root) => join(root, 'refs', 'remotes')),
  );
  const packedRefs = new Set(roots.map((root) => join(root, 'packed-refs')));
  function fingerprint(previous?: ReadonlyMap<string, string>) {
    const result = new Map<string, string>();
    let bytes = 0;
    let newPaths = 0;
    function visit(path: string, descend = true) {
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(path);
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
      if (result.has(path) || remoteRefs.has(path)) return;
      if (!previous?.has(path) && ++newPaths > 10000)
        throw new WorkerError(65, `worker git metadata exceeds 10000: ${path}`);
      let value = `${stat.mode}`;
      if (stat.isSymbolicLink()) value += `:${readlinkSync(path)}`;
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > 64 * 1024 * 1024)
          throw new WorkerError(
            65,
            `worker git metadata exceeds 64 MB: ${path}`,
          );
        let content = readBytes(path, 64 * 1024 * 1024 - bytes + stat.size);
        if (packedRefs.has(path)) {
          const kept = withoutRemoteRefs(content.toString('latin1'));
          // Only remote-tracking refs: as if the file were absent.
          if (
            kept
              .split('\n')
              .every((line) => line === '' || line.startsWith('#'))
          )
            return;
          content = Buffer.from(kept, 'latin1');
        }
        value += `:${createHash('sha256').update(content).digest('hex')}`;
      }
      result.set(path, value);
      if (!stat.isDirectory() || !descend) return;
      const dir = opendirSync(path);
      try {
        for (let entry = dir.readSync(); entry; entry = dir.readSync())
          visit(join(path, entry.name));
      } finally {
        dir.closeSync();
      }
    }
    try {
      for (const root of roots) {
        // Check every ancestor before accessing a resolved worktree Git dir.
        let cursor = parse(resolve(root)).root;
        let unsafe = false;
        for (const part of relativeParts(root)) {
          cursor = join(cursor, part);
          let stat: ReturnType<typeof lstatSync>;
          try {
            stat = lstatSync(cursor);
          } catch (error) {
            if (!isMissing(error)) throw error;
            unsafe = true;
            break;
          }
          if (stat.isSymbolicLink() || !stat.isDirectory()) {
            visit(cursor, false);
            unsafe = true;
            break;
          }
        }
        if (unsafe) continue;
        visit(root, false);
        for (const name of [
          'HEAD',
          'index',
          'packed-refs',
          'refs',
          'config',
          'config.worktree',
          'hooks',
          'info',
          ...readdirSync(root).filter((name) => name.endsWith('.lock')),
        ])
          visit(join(root, name));
      }
      return result;
    } catch (error) {
      if (error instanceof WorkerError) throw error;
      throw new WorkerError(70, 'worker git metadata enumeration failed');
    }
  }
  const baseline = fingerprint();
  return () => {
    const current = fingerprint(baseline);
    return [...new Set([...baseline.keys(), ...current.keys()])]
      .filter((path) => baseline.get(path) !== current.get(path))
      .sort();
  };
}

function relativeParts(path: string) {
  const absolute = resolve(path);
  return absolute.slice(parse(absolute).root.length).split('/').filter(Boolean);
}

// Drops remote-tracking ref lines and the peeled lines that follow them.
function withoutRemoteRefs(text: string) {
  const oid = '(?:[0-9a-f]{40}|[0-9a-f]{64})';
  const remoteLine = new RegExp(`^${oid} refs/remotes/[^\\s]+$`);
  const peeledLine = new RegExp(`^\\^${oid}$`);
  let remote = false;
  return text
    .split('\n')
    .filter((line) => {
      if (remote && peeledLine.test(line)) return false;
      remote =
        remoteLine.test(line) &&
        validRefName(line.slice(line.indexOf(' ') + 1));
      return !remote;
    })
    .join('\n');
}

// The rules of `git check-ref-format`: Git refuses to read a packed-refs file
// holding any other name, so such a line stays in the fingerprint.
function validRefName(name: string) {
  if (name === '@' || name.endsWith('.') || name.endsWith('/')) return false;
  if (/\.\.|@\{|\/\/|[\s~^:?*[\\]/.test(name)) return false;
  for (const char of name)
    if (char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f) return false;
  return name
    .split('/')
    .every(
      (part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'),
    );
}
