#!/usr/bin/env python3
"""Deterministic filesystem/environment observer for confine.sh."""
import json
import os
from pathlib import Path
import re
import tempfile


def write_denied(path: Path) -> bool:
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except OSError:
        return True
    else:
        os.close(fd)
        try:
            path.unlink()
        except OSError:
            pass
        return False


def mount_type(target: str) -> str | None:
    target = os.path.normpath(target)
    try:
        lines = Path('/proc/self/mountinfo').read_text().splitlines()
    except OSError:
        return None
    for line in lines:
        left, sep, right = line.partition(' - ')
        if not sep:
            continue
        fields = left.split()
        if len(fields) > 4 and fields[4].replace('\\040', ' ') == target:
            return right.split()[0]
    return None


cwd = Path.cwd().resolve()
repo = Path(os.environ.get('KRN_CONFINE_REPO', '/mnt/storage/coding/krn/active/krn'))
if cwd.parent.name != 'worktrees' or cwd.parent.parent.name != '.krn':
    raise SystemExit('observer cwd is not a task worktree')
repo_from_cwd = cwd.parent.parent.parent.resolve()
if repo_from_cwd != repo.resolve():
    raise SystemExit('observer repo does not match wrapper repo')

with tempfile.NamedTemporaryFile(prefix='.krn-confine-inside-', dir=cwd, delete=False) as inside:
    inside.write(b'confine observer\n')
    inside_path = Path(inside.name)
inside_write = inside_path.is_file()
inside_path.unlink()

main_checkout_denied = write_denied(repo / 'AGENTS.md')
other_roots = sorted(p for p in (repo / '.krn/worktrees').iterdir() if p.is_dir() and p.resolve() != cwd)
nonce = re.sub(r'[^A-Za-z0-9_.-]', '_', os.environ.get('KRN_CONFINE_SCOPE_UNIT', 'observer'))
other_worktree_denied = bool(other_roots) and write_denied(other_roots[0] / f'.krn-confine-outside-{nonce}')
outside_sentinel = Path(f'/var/tmp/krn-confine-outside-{os.getuid()}-{nonce}')
outside_denied = write_denied(outside_sentinel)

hidden_paths = os.environ.get('KRN_CONFINE_HIDDEN_PATHS', '').split()
hidden = {}
for value in hidden_paths:
    path = Path(value)
    if not path.exists():
        hidden[value] = True
    else:
        try:
            hidden[value] = mount_type(value) == 'tmpfs' and not any(path.iterdir())
        except (OSError, NotADirectoryError):
            hidden[value] = False

forbidden = re.compile(r'(TOKEN|KEY|SECRET|PAPERCLIP|^GH_|^KRN_PAPERCLIP)', re.I)
leaked_names = sorted(name for name in os.environ if forbidden.search(name))
unit = os.environ.get('KRN_CONFINE_SCOPE_UNIT', '')
try:
    cgroup = Path('/proc/self/cgroup').read_text()
except OSError:
    cgroup = ''
scope_matched = bool(unit) and unit in cgroup

tmp_private = mount_type('/tmp') == 'tmpfs'
result = {
    'insideWrite': inside_write,
    'mainCheckoutWriteDenied': main_checkout_denied,
    'otherWorktreeWriteDenied': other_worktree_denied,
    'outsideSentinelWriteDenied': outside_denied,
    'secretPathsHidden': hidden,
    'envSecretsAbsent': leaked_names,
    'scopeMatched': scope_matched,
    'tmpPrivate': tmp_private,
}
print('KRN_CONFINE_JSON=' + json.dumps(result, sort_keys=True, separators=(',', ':')))
