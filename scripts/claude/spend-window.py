#!/usr/bin/env python3
"""Lead and subagent dollars per merged PR inside a time window.
Usage: spend-window.py <start-iso> <end-iso> [transcript-dir] [repo]
Lead turns are priced by message timestamp; subagent turns likewise, grouped by agentType.
PRs are first-parent main commits titled "(#n)" committed inside the window."""
import collections, datetime as dt, glob, json, os, re, subprocess, sys

P = {'claude-opus-5-5': (4, 20, .2), 'claude-opus-5': (5, 25, .5), 'claude-opus-4-8': (5, 25, .5),
     'claude-opus-4-7': (5, 25, .5), 'claude-opus-4-6': (5, 25, .5), 'claude-sonnet-5-5': (2, 10, .2),
     'claude-sonnet-5': (2, 10, .2), 'claude-sonnet-4-6': (3, 15, .3), 'claude-haiku-5-5': (.1, .5, .01),
     'claude-haiku-4-5': (1, 5, .1), 'claude-fable-5-1': (10, 50, .25), 'claude-fable-5': (10, 50, 1.0)}
ts = lambda s: dt.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
a, b = ts(sys.argv[1]), ts(sys.argv[2])
root = sys.argv[3] if len(sys.argv) > 3 else os.path.expanduser('~/.claude/projects/-mnt-storage-coding-krn-active-krn')
repo = sys.argv[4] if len(sys.argv) > 4 else os.getcwd()
unknown = collections.Counter()

def price(model, u):
    p = P.get(model)
    if not p:
        unknown[model] += 1
        return 0.0
    g = lambda k: u.get(k) or 0
    cc = u.get('cache_creation') or {}
    w5, w1 = cc.get('ephemeral_5m_input_tokens'), cc.get('ephemeral_1h_input_tokens')
    tot = g('cache_creation_input_tokens')
    if w5 is None and w1 is None:
        w5, w1 = tot, 0
    else:
        w5, w1 = w5 or 0, w1 or 0
        w5 += max(0, tot - w5 - w1)
    return (g('input_tokens') * p[0] + (w5 * 1.25 + w1 * 2) * p[0] + g('cache_read_input_tokens') * p[2]
            + g('output_tokens') * p[1]) / 1e6

def turns(path):
    """Yield (timestamp, model, usage) once per assistant message id inside the window."""
    seen = {}
    for line in open(path, errors='replace'):
        try:
            d = json.loads(line)
        except Exception:
            continue
        m = d.get('message')
        if d.get('type') != 'assistant' or not m or not d.get('timestamp'):
            continue
        seen[m.get('id') or d.get('uuid')] = (ts(d['timestamp']), m.get('model'), m.get('usage') or {})
    return [t for t in seen.values() if a <= t[0] < b]

log = subprocess.run(['git', '-C', repo, 'log', '--first-parent', 'origin/main', '--format=%cI\t%s'],
                     capture_output=True, text=True, check=True).stdout.splitlines()
prs = sum(1 for l in log if a <= ts(l.split('\t')[0]) < b and re.search(r'\(#\d+\)$', l))
lead = sum(price(m, u) for f in glob.glob(f'{root}/*.jsonl') for _, m, u in turns(f))
by = collections.defaultdict(lambda: [0, 0.0, 0])
for f in glob.glob(f'{root}/*/subagents/*.jsonl'):
    t = turns(f)
    if not t:
        continue
    try:
        kind = json.load(open(f[:-6] + '.meta.json')).get('agentType', '?')
    except Exception:
        kind = '?'
    r = by[kind]
    r[0] += 1
    r[1] += sum(price(m, u) for _, m, u in t)
    r[2] += len(t)
sub = sum(r[1] for r in by.values())
n = max(prs, 1)
print(f'{sys.argv[1]}..{sys.argv[2]}: {prs} PRs')
print(f'lead ${lead:.2f} = ${lead / n:.2f}/PR; subagents ${sub:.2f} = ${sub / n:.2f}/PR; total ${(lead + sub) / n:.2f}/PR')
for k, r in sorted(by.items(), key=lambda x: -x[1][1]):
    print(f'  {k:18s} agents={r[0]:3d} turns={r[2]:5d} ${r[1]:7.2f}')
if unknown:
    print('unpriced models:', dict(unknown))
