#!/usr/bin/env bash
# Remove the worktree for an assignment and delete its branch.
# Refuses to delete a branch that is not merged into its base, unless
# called with --force.
#
# Usage: scripts/agents/cleanup.sh [--force] <id> [<id>...]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

force=0
ids=()
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    --) ;;
    *) ids+=("$arg") ;;
  esac
done

if [ ${#ids[@]} -eq 0 ]; then
  echo "usage: $0 [--force] <id> [<id>...]" >&2
  exit 1
fi

repo_root=$(agents_repo_root)
log_dir="${AGENT_LOG_DIR:-/tmp/agents}"
cd "$repo_root"

for id in "${ids[@]}"; do
  assignment=$(agents_require_assignment "$id")

  branch=$(agents_field branch "$assignment")
  base=$(agents_field base "$assignment")
  worktree=$(agents_field worktree "$assignment")

  if [ -d "$worktree" ]; then
    git worktree remove "$worktree" $([ $force -eq 1 ] && echo --force)
    echo "[$id] worktree removed: $worktree"
  else
    echo "[$id] no worktree at $worktree (skipping)"
  fi

  if git rev-parse --verify "refs/heads/$branch" >/dev/null 2>&1; then
    if [ $force -eq 1 ]; then
      git branch -D "$branch"
      echo "[$id] branch force-deleted: $branch"
    elif git merge-base --is-ancestor "$branch" "$base"; then
      git branch -d "$branch"
      echo "[$id] branch deleted: $branch"
    else
      echo "[$id] branch $branch is NOT merged into $base; not deleting (use --force to override)"
    fi
  fi

  rm -f "$log_dir/${id}.log"
done
