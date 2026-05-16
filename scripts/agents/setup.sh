#!/usr/bin/env bash
# Create the worktree for an agent assignment and drop AGENT_ASSIGNMENT.md
# into it. Idempotent: re-running refreshes the assignment copy without
# recreating the worktree.
#
# Usage: scripts/agents/setup.sh <id> [<id>...]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

if [ $# -lt 1 ]; then
  echo "usage: $0 <id> [<id>...]" >&2
  exit 1
fi

repo_root=$(agents_repo_root)
cd "$repo_root"

for id in "$@"; do
  assignment=$(agents_require_assignment "$id")

  branch=$(agents_field branch "$assignment")
  base=$(agents_field base "$assignment")
  worktree=$(agents_field worktree "$assignment")

  if [ -z "$branch" ] || [ -z "$base" ] || [ -z "$worktree" ]; then
    echo "[$id] missing required frontmatter (branch/base/worktree)" >&2
    exit 1
  fi

  if [ -d "$worktree" ]; then
    echo "[$id] worktree exists: $worktree"
  elif git rev-parse --verify "refs/heads/$branch" >/dev/null 2>&1; then
    echo "[$id] branch $branch exists; attaching worktree at $worktree"
    git worktree add "$worktree" "$branch"
  else
    echo "[$id] creating branch $branch from $base; worktree at $worktree"
    git worktree add -b "$branch" "$worktree" "$base"
  fi

  cp "$assignment" "$worktree/AGENT_ASSIGNMENT.md"
  echo "[$id] ready (assignment copied to $worktree/AGENT_ASSIGNMENT.md)"
done
