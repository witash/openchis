#!/usr/bin/env bash
# Launch headless Claude agents for one or more assignments in parallel.
# Each agent runs in its own worktree. Logs go to /tmp/agents/<id>.log.
#
# Usage: scripts/agents/run.sh <id> [<id>...]
#
# Prints PIDs and a one-liner to wait for completion. The agents are
# backgrounded under this shell — if you close the terminal, they die.
# Wrap with nohup or run inside tmux/screen for long jobs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

if [ $# -lt 1 ]; then
  echo "usage: $0 <id> [<id>...]" >&2
  exit 1
fi

repo_root=$(agents_repo_root)
log_dir="${AGENT_LOG_DIR:-/tmp/agents}"
mkdir -p "$log_dir"

pids=()
for id in "$@"; do
  assignment=$(agents_require_assignment "$id")

  branch=$(agents_field branch "$assignment")
  worktree=$(agents_field worktree "$assignment")

  if [ ! -d "$repo_root/$worktree" ]; then
    echo "[$id] no worktree at $worktree — run setup.sh first" >&2
    exit 1
  fi
  if [ ! -f "$repo_root/$worktree/AGENT_ASSIGNMENT.md" ]; then
    echo "[$id] AGENT_ASSIGNMENT.md missing in $worktree — run setup.sh" >&2
    exit 1
  fi

  prompt=$(agents_build_prompt "$id" "$branch")
  log="$log_dir/${id}.log"

  (
    cd "$repo_root/$worktree"
    claude -p --verbose --output-format stream-json "$prompt"
  ) >"$log" 2>&1 &
  pid=$!
  pids+=("$pid")
  echo "[$id] launched PID=$pid log=$log"
done

echo ""
echo "Tail all:  tail -f ${log_dir}/{$(IFS=,; echo "$*")}.log"
echo "Wait all:  wait ${pids[*]}"
