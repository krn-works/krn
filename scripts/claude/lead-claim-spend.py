#!/usr/bin/env python3
"""Lead dollars per UTC day, split into turns while a task claim was open and turns with none open.
Usage: lead-claim-spend.py <start-iso> <end-iso> [transcript-dir] [repo]
Read-only. Prices come from scripts/claude/spend-window.py (its P table and price() are extracted, not copied).
A claim opens at a `krn task claim <id>` or `krn lane start ... --task <id>` command (id from the command, or from the
output of `claim --next`) and closes at the earliest of a `task close|release <id>` command in any transcript (lead or
subagent) or the first-parent main commit titled `(<id>)` after it. A claim older than 6 h at that point is stale: it ends at
the last Bash command that named the id within 6 h of the claim (counted as stale), so a claim left open for days does not count as work.
Commands are read only up to their first heredoc; lead turns are the sessions spend-window.py counts as lead."""
import ast, bisect, collections, datetime as dt, glob, json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, 'spend-window.py')).read()
keep = [n for n in ast.parse(src).body if (isinstance(n, ast.Assign) and getattr(n.targets[0], 'id', '') == 'P')
        or (isinstance(n, ast.FunctionDef) and n.name == 'price')]
unknown = collections.Counter()
ns = {'unknown': unknown}
exec(compile(ast.Module(keep, []), 'spend-window.py', 'exec'), ns)
price = ns['price']

ts = lambda s: dt.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
a, b = ts(sys.argv[1]), ts(sys.argv[2])
root = sys.argv[3] if len(sys.argv) > 3 else os.path.expanduser('~/.claude/projects/-mnt-storage-coding-krn-active-krn')
repo = sys.argv[4] if len(sys.argv) > 4 else os.getcwd()
roots = [root] + sorted(glob.glob(glob.escape(root.rstrip('/')) + '--krn-worktrees-*'))
STALE = 6 * 3600
ID = r'(t-[a-z0-9]{5,9})'
CMD = re.compile(r'(?:^|[;&|(]\s*|\n)\s*(?:\S*/)?krn (task (?:claim|release|close)|lane start)\b([^\n;&|]*)')

def rows(path):
    for line in open(path, errors='replace'):
        try:
            yield json.loads(line)
        except Exception:
            pass

mention = {}  # id -> times of Bash commands naming it, other than close and release
events = []  # (time, kind, id) kind in open/close
def scan(path):
    pend = {}
    for d in rows(path):
        m = d.get('message')
        if not m or not isinstance(m.get('content'), list) or not d.get('timestamp'):
            continue
        for blk in m['content']:
            if blk.get('type') == 'tool_use' and blk.get('name') == 'Bash':
                cmd = blk['input'].get('command', '').split('<<')[0]
                if not re.search(r'krn task (close|release)', cmd):
                    for i in re.findall(ID, cmd):
                        mention.setdefault(i, []).append(ts(d['timestamp']))
                for mm in CMD.finditer(cmd):
                    what, rest = mm.group(1), mm.group(2)
                    t = ts(d['timestamp'])
                    if what == 'task claim' or what == 'lane start':
                        i = re.search((r'--task ' if what == 'lane start' else r'claim ') + ID, mm.group(0)) or re.search(r'\bclaim ' + ID, mm.group(0))
                        if what == 'lane start' and not re.search(r'--task ' + ID, rest):
                            continue
                        if i:
                            events.append((t, 'open', i.group(1)))
                        elif '--next' in rest:
                            pend[blk['id']] = t
                    else:
                        i = re.search(ID, rest)
                        if i:
                            events.append((ts(d['timestamp']), 'close', i.group(1)))
            elif blk.get('type') == 'tool_result' and blk.get('tool_use_id') in pend:
                c = blk.get('content')
                c = c if isinstance(c, str) else ' '.join(x.get('text', '') for x in c)
                i = re.search(ID, c)
                if i and not blk.get('is_error'):
                    events.append((pend.pop(blk['tool_use_id']), 'open', i.group(1)))

lead_files = [f for r in roots for f in glob.glob(f'{r}/*.jsonl')]
for f in lead_files + [f for r in roots for f in glob.glob(f'{r}/*/subagents/*.jsonl')]:
    scan(f)

log = subprocess.run(['git', '-C', repo, 'log', '--first-parent', 'origin/main', '--format=%cI\t%s'],
                     capture_output=True, text=True, check=True).stdout.splitlines()
merges = collections.defaultdict(list)
prs = []
for l in log:
    t, s = l.split('\t', 1)
    t = ts(t)
    if re.search(r'\(#\d+\)$', s) and a <= t < b:
        prs.append(t)
    m = re.search(r'\((t-[a-z0-9]{5,9})\)(?: \(#\d+\))?$', s)
    if m:
        merges[m.group(1)].append(t)

events.sort()
stale = 0  # claims older than STALE hours when closed or merged
intervals = []  # (start, end)
open_at = {}
closes = collections.defaultdict(list)
for t, k, i in events:
    if k == 'close':
        closes[i].append(t)
for t, k, i in events:
    if k != 'open' or i in open_at:
        continue
    ends = [e for e in closes[i] if e >= t] + [e for e in merges[i] if e >= t]
    end = min(ends + [b])
    if end - t > STALE:  # held without work: ends at the last command that named the id
        stale += 1
        end = min(end, max([t] + [m for m in mention.get(i, []) if t <= m <= min(end, t + STALE)]))
    intervals.append((t, end))
intervals.sort()
# union of intervals
union = []
for s, e in intervals:
    if union and s <= union[-1][1]:
        union[-1][1] = max(union[-1][1], e)
    else:
        union.append([s, e])
starts = [u[0] for u in union]
def claimed(t):
    j = bisect.bisect_right(starts, t) - 1
    return j >= 0 and t < union[j][1]

day = lambda t: dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime('%m-%d')
agg = collections.defaultdict(lambda: [0.0, 0, 0.0, 0])  # claimed $, turns, unclaimed $, turns
for f in lead_files:
    seen = {}
    for d in rows(f):
        m = d.get('message')
        if d.get('type') == 'assistant' and m and d.get('timestamp'):
            seen[m.get('id') or d.get('uuid')] = (ts(d['timestamp']), m.get('model'), m.get('usage') or {})
    for t, model, u in seen.values():
        if not a <= t < b:
            continue
        r = agg[day(t)]
        c = price(model, u)
        if claimed(t):
            r[0] += c; r[1] += 1
        else:
            r[2] += c; r[3] += 1
# PRs by mergedAt from gh (the first-parent log misses merges whose history was squashed); git is the fallback
try:
    gh = subprocess.run(['gh', 'pr', 'list', '--state', 'merged', '--limit', '2000', '--json', 'mergedAt', '-q', '.[].mergedAt'],
                        cwd=repo, capture_output=True, text=True, check=True).stdout.split()
    prs = [ts(x) for x in gh if a <= ts(x) < b]
except Exception:
    pass
prs_by_day = collections.Counter(day(t) for t in prs)
print(f'{sys.argv[1]}..{sys.argv[2]}: {len(events)} claim events, {len(intervals)} claims, {len(union)} merged intervals, {stale} stale')
print('| day | PRs | lead $ | claimed $ | unclaimed $ | unclaimed share | claimed turns | unclaimed turns | $/PR | claimed $/PR | unclaimed $/PR |')
print('|---|---|---|---|---|---|---|---|---|---|---|')
tot = [0.0, 0, 0.0, 0]
for d in sorted(agg):
    c, ct, u, ut = agg[d]
    n = prs_by_day[d]
    tot = [tot[0] + c, tot[1] + ct, tot[2] + u, tot[3] + ut]
    print(f'| {d} | {n} | {c + u:.2f} | {c:.2f} | {u:.2f} | {u / ((c + u) or 1):.0%} | {ct} | {ut} | {(c + u) / max(n, 1):.2f} | {c / max(n, 1):.2f} | {u / max(n, 1):.2f} |')
print(f'| all | {len(prs)} | {tot[0] + tot[2]:.2f} | {tot[0]:.2f} | {tot[2]:.2f} | {tot[2] / ((tot[0] + tot[2]) or 1):.0%} | {tot[1]} | {tot[3]} | {(tot[0] + tot[2]) / max(len(prs), 1):.2f} | {tot[0] / max(len(prs), 1):.2f} | {tot[2] / max(len(prs), 1):.2f} |')
if unknown:
    print('unpriced models:', dict(unknown))
if os.environ.get('DEBUG'):
    for s, e in intervals:
        print(dt.datetime.fromtimestamp(s, dt.timezone.utc).strftime('%m-%d %H:%M'), f'{(e - s) / 3600:.1f}h')
