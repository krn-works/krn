#!/usr/bin/env bash
# Maintain the pinned Product checkout that `krn task` should run.
# Creates or fast-forwards a detached worktree at <main checkout>/.krn/product-release
# on origin/main and prints the entry path and commit. Point the host entry at it:
#   scripts/product-release.sh --entry > ~/.config/krn/product-entry
# `krn ci wait` runs it once it observes the merge; switching the working
# checkout never changes this one. The candidate must pass `bin/krn doctor`
# before it stays; a failed smoke restores the previous commit and exits 78.
set -euo pipefail

mode=${1:-}
case "$mode" in
  ''|--entry|--commit) ;;
  *) printf 'usage: product-release.sh [--entry|--commit]\n' >&2; exit 64 ;;
esac

common=$(git rev-parse --path-format=absolute --git-common-dir)
main=$(dirname "$common")
release=$main/.krn/product-release
branch=${KRN_PRODUCT_BRANCH:-main}
remote=${KRN_PRODUCT_REMOTE:-origin}

git -C "$main" fetch -q "$remote" "$branch"
target=$(git -C "$main" rev-parse "$remote/$branch")
previous=
if [[ -e "$release/.git" ]]; then
  previous=$(git -C "$release" rev-parse HEAD)
  git -C "$release" checkout -q --detach "$target"
else
  git -C "$main" worktree add -q --detach "$release" "$target"
fi
if [[ ! -e "$release/node_modules" && -d "$main/node_modules" ]]; then
  ln -s "$main/node_modules" "$release/node_modules"
fi

# Smoke the candidate as the entry it becomes; keep the previous commit on failure.
if ! KRN_PRODUCT_ENTRY="$release/bin/krn" "$release/bin/krn" doctor >/dev/null 2>&1; then
  if [[ -n "$previous" ]]; then
    git -C "$release" checkout -q --detach "$previous"
    printf 'product-release: candidate %s failed bin/krn doctor; kept previous=%s\n' "$target" "$previous" >&2
  else
    git -C "$main" worktree remove --force "$release"
    printf 'product-release: candidate %s failed bin/krn doctor; no previous commit\n' "$target" >&2
  fi
  exit 78
fi

case "$mode" in
  --entry) printf '%s\n' "$release/bin/krn" ;;
  --commit) printf '%s\n' "$target" ;;
  *) printf 'entry=%s\nprevious=%s\ncommit=%s\n' "$release/bin/krn" "${previous:-none}" "$target" ;;
esac
