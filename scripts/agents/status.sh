#!/usr/bin/env bash
# Report per-assignment state: worktree presence, branch commits ahead of
# base, last 3 commits, last 3 lines of log.
#
# Usage: scripts/agents/status.sh [<id>...]
# With no args, reports on every assignment under .agents/assignments/.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

repo_root=$(agents_repo_root)
log_dir="${AGENT_LOG_DIR:-/tmp/agents}"
cd "$repo_root"

if [ $# -gt 0 ]; then
  ids=("$@")
else
  ids=()
  for f in .agents/assignments/*.md; do
    [ -f "$f" ] || continue
    ids+=("$(basename "$f" .md)")
  done
fi

if [ ${#ids[@]} -eq 0 ]; then
  echo "no assignments found under .agents/assignments/"
  exit 0
fi

for id in "${ids[@]}"; do
  assignment=$(agents_assignment_path "$id")
  if [ ! -f "$assignment" ]; then
    echo "== $id =="
    echo "  no assignment file"
    continue
  fi

  branch=$(agents_field branch "$assignment")
  base=$(agents_field base "$assignment")
  worktree=$(agents_field worktree "$assignment")
  log="$log_dir/${id}.log"

  echo "== $id =="
  if [ -d "$worktree" ]; then
    ahead=$(git -C "$worktree" rev-list --count "$branch" "^$base" 2>/dev/null || echo "?")
    echo "  worktree: $worktree  (commits ahead of $base: $ahead)"
    git -C "$worktree" log --oneline -3 2>/dev/null | sed 's/^/    /'
    status=$(git -C "$worktree" status --short 2>/dev/null)
    if [ -n "$status" ]; then
      echo "  uncommitted:"
      echo "$status" | sed 's/^/    /'
    fi
  else
    echo "  worktree: not created"
  fi
  if [ -f "$log" ]; then
    echo "  log tail:"
    tail -3 "$log" | sed 's/^/    /'
  fi
done
