# Shared helpers for scripts/agents/*.
# Sourced, not executed. No shebang.

# Resolve the repo root from any cwd.
agents_repo_root() {
  git rev-parse --show-toplevel
}

# Path to an assignment file for a given id.
agents_assignment_path() {
  local id="$1"
  echo "$(agents_repo_root)/.agents/assignments/${id}.md"
}

# Extract a scalar field from an assignment's YAML frontmatter.
# Usage: agents_field <key> <file>
# Frontmatter shape:
#   ---
#   key: value
#   ---
# Values may contain spaces; no multi-line values, no lists, no nesting.
agents_field() {
  local key="$1" file="$2"
  awk -v key="$key" '
    BEGIN { fm = 0 }
    /^---[[:space:]]*$/ { fm = !fm; next }
    fm && $0 ~ ("^"key":") {
      sub("^"key":[[:space:]]*", "")
      print
      exit
    }
  ' "$file"
}

# Require an assignment file to exist; print to stderr and exit if not.
agents_require_assignment() {
  local id="$1"
  local path
  path=$(agents_assignment_path "$id")
  if [ ! -f "$path" ]; then
    echo "no assignment: $path" >&2
    return 1
  fi
  echo "$path"
}

# Standard prompt every agent receives. The assignment file is the source of
# task-specific detail; this only carries the cross-cutting boilerplate.
agents_build_prompt() {
  local id="$1" branch="$2"
  cat <<EOF
You are the agent for ${id}.

Read AGENT_ASSIGNMENT.md in this worktree — it is your task brief. Then follow
the "Resuming after interruption" protocol from PROJECT.md's Working Agreement
before doing any new work.

Constraints:
- Stay on branch ${branch}. Do not switch branches and do not push to remote.
- You are headless: no human will answer permission prompts. If you hit a
  permission denial, change approach (try a different tool, leave a follow-up
  note in TASK_STATE.md, or fail loudly) rather than wait.
- Unit tests must mock services (Postgres, CouchDB). Do not require live
  services to run.
- Commit when your task's unit tests pass.
- Keep TASK_STATE.md updated so a restart agent can resume cleanly.
EOF
}
