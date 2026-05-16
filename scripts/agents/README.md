# Agent setup

Tooling for running headless Claude Code agents in parallel git worktrees.
Adapted from the cht-agent ticket-format idea, minus the containerization
and looping.

## Flow

```
┌─────────────────┐    interactive Claude in main worktree
│   PROJECT.md    │ ──────────────────────────────────────┐
└─────────────────┘                                       │
                                                          ▼
                                          .agents/assignments/<id>.md
                                          (one file per task)
                                                          │
                                              setup.sh <id>
                                                          ▼
                                          .agents/<id>/  (git worktree)
                                            AGENT_ASSIGNMENT.md (copy)
                                                          │
                                              run.sh <id> [<id>...]
                                                          ▼
                                          claude -p running headless
                                            logs → /tmp/agents/<id>.log
```

You produce assignment files interactively (a Claude conversation in the
main worktree turns `PROJECT.md` into per-task briefs). The scripts then
handle worktree creation and headless launch. No orchestrator daemon,
no container, no loop.

## Files

- `lib.sh` — shared bash helpers: frontmatter parser, prompt template.
- `setup.sh <id>...` — creates worktree, copies assignment in.
- `run.sh <id>...` — launches headless `claude -p` per id, in parallel.
- `status.sh [<id>...]` — reports worktree state, log tail.
- `cleanup.sh [--force] <id>...` — removes worktree, deletes merged branch.

## Assignment file format

Lives at `.agents/assignments/<id>.md`. Gitignored — assignments are
scratch artefacts, not committed history. (PROJECT.md is the durable
record; assignments are the per-task carve-out.)

```markdown
---
id: task-1-couch2pg
branch: task-1-couch2pg
base: postgres-sync-poc
worktree: .agents/task-1-couch2pg
done_when: cd couch2pg && npm test
---

# Task 1 — couch2pg mirror worker

(Goal, references, constraints, done-when in prose. The agent reads this
as its task brief.)
```

Required frontmatter:

| key | meaning |
|---|---|
| `id` | short slug; matches the filename and is used in logs |
| `branch` | git branch the agent works on |
| `base` | branch the new branch forks from (and that we test "merged" against in cleanup) |
| `worktree` | path where the worktree is created (typically `.agents/<id>`) |
| `done_when` | shell command that should exit 0 when the task is complete; documentation only — scripts don't auto-invoke it (yet) |

Body is free-form markdown. The agent reads `AGENT_ASSIGNMENT.md` (a copy
that `setup.sh` drops into the worktree).

## Typical session

```bash
# 1. Write or edit assignment files interactively
$EDITOR .agents/assignments/task-4-integration.md

# 2. Create the worktree(s)
scripts/agents/setup.sh task-4-integration

# 3. Launch
scripts/agents/run.sh task-4-integration
# or in parallel:
scripts/agents/run.sh task-1-couch2pg task-2-pg-sync

# 4. Watch
scripts/agents/status.sh
tail -f /tmp/agents/task-4-integration.log

# 5. When done, merge manually (per PROJECT.md), then
scripts/agents/cleanup.sh task-4-integration
```

## Conventions enforced by the agent prompt

The standard prompt (in `lib.sh:agents_build_prompt`) tells every agent:

- Read `AGENT_ASSIGNMENT.md` first.
- Follow PROJECT.md's "Resuming after interruption" protocol before
  starting new work.
- Stay on its branch; no remote pushes.
- Headless mode: no human will answer permission prompts; redesign the
  approach rather than wait.
- Unit tests mock services; do not require live CouchDB/Postgres.
- Commit when unit tests pass.
- Maintain `TASK_STATE.md` for resume continuity.

Task-specific detail (what to build, where, against which fixtures)
belongs in the assignment body — not in the prompt.

## What this deliberately does not do

- **No container.** Agents run as plain `claude -p` processes.
- **No loop.** Each agent is one-shot. If a task isn't done in one run,
  re-launch and the agent picks up via the Resuming protocol.
- **No automatic merging.** Merging tasks back to base is a manual
  decision; PROJECT.md spells it out.
- **No dependency graph.** Parallelism is implicit — pass multiple ids
  to `run.sh` to launch them concurrently; pass one for sequential.
- **No daemon.** Scripts exit when launched; agents run in the
  background under your shell. Use `tmux`/`nohup` for long jobs.
