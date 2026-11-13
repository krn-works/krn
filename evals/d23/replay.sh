#!/usr/bin/env bash
# usage: replay.sh <pr> <K|P|PB>   one arm of one unit, then its measures
# P is the plain clone, PB the plain clone given the same requirements text K gets, K the KRN product.
# RUN names a repeat: results land in $OUT/run$RUN; work dirs carry it so repeats can run side by side.
# IFACE: text appended for K and PB; IFACE_BASE (default IFACE): text appended for P.
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# The main checkout holds run state and node_modules even when this runs from a lane worktree.
REPO=${REPO:-${HERE%%/.krn/worktrees/*}}
REPO=${REPO%/evals/d23}
[ -f "$REPO/.krn/tmp/genv.sh" ] && . "$REPO/.krn/tmp/genv.sh"
set -u
WORK=${D23_TMP:-/mnt/storage/tmp/d23}
OUT=${OUT:-$REPO/.krn/runs/d23-comparison/results}
[ -n "${RUN:-}" ] && OUT=$OUT/run$RUN
# IFACE: directory of <pr>.txt interface paragraphs appended to the task for both arms.
# HARNESS_REF: K runs on that ref's harness files minus the ones the PR changed (evals/d23/harness.ts), committed as its base.
mkdir -p $OUT
n=$1; arm=$2; tag=$n.$arm
sha=$(git -C $REPO log --first-parent --format='%H %s' | grep -E "\(#$n\)\$" | cut -d' ' -f1)
parent=$(git -C $REPO rev-parse $sha^)
task=$(git -C $REPO log -1 --format=%s $sha | grep -oE 't-[a-z0-9]{7}' | tail -1)
D=$WORK/$arm$n.r${RUN:-0}
rm -rf $D; mkdir -p $D
git -C $REPO show $sha:tasks/$task.json | python3 -c '
import json,sys
t=json.load(sys.stdin)
print("Task %s: %s\n\n%s" % (t["id"],t["title"],"\n".join(t["body"])))' > $OUT/$tag.task.txt
text=${IFACE:-}; [ $arm = P ] && text=${IFACE_BASE:-${IFACE:-}}
if [ -n "$text" ] && [ -f "$text/$n.txt" ]; then cat "$text/$n.txt" >> $OUT/$tag.task.txt; fi
# Both arms get the whole history up to the parent and nothing after it: the fetch names only the parent.
cd $D && git init -q . && git fetch -q file://$REPO $parent && git checkout -q FETCH_HEAD && git checkout -q -b replay
git config user.name replay; git config user.email replay@invalid
ln -s $REPO/node_modules node_modules
base=$parent
if [ $arm != K ]; then
  git rm -rq --ignore-unmatch .claude .agents CLAUDE.md AGENTS.md && git commit -qm "strip harness files" && base=$(git rev-parse HEAD)
  export PATH=$WORK/shim:$PATH
  prompt="You are working in this repository clone (no remote; do not try to push or open a PR). Deliver this task: $(cat $OUT/$tag.task.txt)

Commit your change with a test."
else
  if [ -n "${HARNESS_REF:-}" ]; then
    node $HERE/harness.ts $D $HARNESS_REF $parent $sha > $OUT/$tag.harness
    git add -A && git commit -qm "harness at $HARNESS_REF" && base=$(git rev-parse HEAD)
  fi
  # K is a lane worker: the task brief goes through `krn lane brief` of HARNESS_REF's krn (its own
  # worktree, run against the clone), as `krn lane run` builds it, and the worker guard applies.
  krnroot=$D
  if [ -n "${HARNESS_REF:-}" ]; then
    krnroot=$WORK/krn$n.r${RUN:-0}
    git -C $REPO worktree remove --force $krnroot 2>/dev/null; rm -rf $krnroot
    git -C $REPO worktree add -q --detach $krnroot $HARNESS_REF
    ln -s $REPO/node_modules $krnroot/node_modules
  fi
  asof=$(git -C $REPO log -1 --format=%cs $parent)
  prompt=$(cd $D && { printf 'This repository clone has no remote: commit locally with a conventional commit title ending in the task id; do not push or open a pull request.\n\n'; cat $OUT/$tag.task.txt; } | $krnroot/bin/krn lane brief --root $D --task $task --as-of $asof)
  # A lane worktree has main at its base; the worker's Stop check measures against it.
  git branch -f main $base
  export KRN_ROLE=worker
  export KRN_SCOPE="$(grep -m1 '^Scope:' $OUT/$tag.task.txt || true)"
  export KRN_TASK=$task
fi
echo $base > $OUT/$tag.base
start=$(date +%s)
run_claude() {
  CLAUDE_CODE_SESSION_ATTENDED=0 timeout 1500 claude -p --model claude-opus-5-5 --effort medium --permission-mode bypassPermissions --max-budget-usd 6 --output-format json "$prompt" > $OUT/$tag.claude.json 2> $OUT/$tag.claude.err
}
# A usage limit is an error claude reports, never text a successful arm wrote (its task may quote one).
limit_hit() {
  python3 - "$OUT/$tag.claude.json" "$OUT/$tag.claude.err" <<'PY'
import json,re,sys
def read(p):
    try: return open(p).read()
    except OSError: return ""
raw=read(sys.argv[1]); err=read(sys.argv[2])
try:
    d=json.loads(raw)
    if not d.get("is_error"): sys.exit(1)
    text=err+"\n"+str(d.get("result",""))
except ValueError:
    text=err+"\n"+raw
sys.exit(0 if re.search(r"hit your .*limit|weekly limit|usage limit",text,re.I) else 1)
PY
}
# seconds until the "resets <time>" the limit message names; capped at 5 h, which is also the answer when no time parses
limit_wait() {
  cat $OUT/$tag.claude.err $OUT/$tag.claude.json 2>/dev/null | python3 -c '
import re,sys,datetime
m=re.search(r"resets(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?",sys.stdin.read(),re.I)
cap=18000
if not m: print(cap); sys.exit()
h=int(m.group(1)); mi=int(m.group(2) or 0); ap=(m.group(3) or "").lower()
if ap=="pm" and h<12: h+=12
if ap=="am" and h==12: h=0
now=datetime.datetime.now()
t=now.replace(hour=h%24,minute=mi,second=0,microsecond=0)
if t<=now: t+=datetime.timedelta(days=1)
print(min(cap,int((t-now).total_seconds())+60))'
}
limit_retry=0
run_claude
claude_rc=$?
if limit_hit; then
  ${D23_SLEEP:-sleep} "$(limit_wait)"
  limit_retry=1
  run_claude
  claude_rc=$?
fi
echo "claude_exit=$claude_rc" > $OUT/$tag.meas
[ $limit_retry = 1 ] && echo "limit_retry=1" >> $OUT/$tag.meas
echo "wall=$(( $(date +%s) - start ))" >> $OUT/$tag.meas
echo "lead_seconds=$(( $(git log -1 --format=%ct) - start ))" >> $OUT/$tag.meas
echo "commits=$(git rev-list --count $base..HEAD)" >> $OUT/$tag.meas
echo "dirty=$(git status --short | grep -v node_modules | wc -l)" >> $OUT/$tag.meas
git diff --name-only $base HEAD > $OUT/$tag.files
git diff $base HEAD > $OUT/$tag.patch
echo "outscope: $(grep -E '^(tasks/|docs/program/roadmap.md|\.claude/|\.agents/|CLAUDE.md|AGENTS.md|\.github/)' $OUT/$tag.files | tr '\n' ' ')" >> $OUT/$tag.meas
own=$(grep -E '^test/.*\.test\.' $OUT/$tag.files | grep -v '^$')
echo "own_tests: $(echo $own)" >> $OUT/$tag.meas
# gate runs on the commit with stripped harness files restored (arm P deleted them only as an arm treatment)
[ $arm != K ] && git checkout -q $parent -- .claude .agents CLAUDE.md AGENTS.md 2>/dev/null
if [ -n "$own" ]; then node --test --test-concurrency=1 $own > $OUT/$tag.own.log 2>&1; echo "own_exit=$?" >> $OUT/$tag.meas; else echo own_exit=none >> $OUT/$tag.meas; fi
# no full suite here: runs.ts grades every run on the hidden tests and the full suite; a serialized npm test per run halved throughput
# noise from transcript
sid=$(python3 -c "import json;print(json.load(open('$OUT/$tag.claude.json')).get('session_id',''))" 2>/dev/null)
proj=$HOME/.claude/projects/$(echo $D | sed 's#[/.]#-#g')
node $HERE/transcript.ts "$proj" "$sid" >> $OUT/$tag.meas
echo measured >> $OUT/$tag.meas
cd /; rm -rf $D
if [ -n "${krnroot:-}" ] && [ "$krnroot" != "$D" ]; then git -C $REPO worktree remove --force $krnroot; fi
