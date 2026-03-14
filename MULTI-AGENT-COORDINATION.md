# Multi-Agent Coordination

## Overview

When multiple solo agents or team members work on the same project, three core problems must be solved:
1. **Conflict Prevention** — prevent multiple agents from modifying the same file simultaneously
2. **Real-time Awareness** — each agent knows what others are doing
3. **Mutual Benefit** — agents can reuse each other's outputs

## Architecture

Hybrid approach: **Git Worktree hard isolation + Activity Board soft coordination**.

```
┌──────────────────────────────────────────────┐
│          Project Coordinator                 │
│  • git worktree management (hard isolation)  │
│  • activity board (soft coordination)        │
│  • conflict detection (git merge-tree)       │
│  • merge sequencing                          │
└──────┬──────────┬──────────┬─────────────────┘
       │          │          │
  worktree-a  worktree-b  worktree-c
  ┌────▼──┐  ┌────▼──┐  ┌───▼───┐
  │Dev A  │  │Dev B  │  │Dev C  │
  └───┬───┘  └───┬───┘  └───┬───┘
      │          │          │
      ▼          ▼          ▼
   branch-a   branch-b   branch-c
      │          │          │
      └────┬─────┘     ┌───┘
           ▼           ▼
      git merge (sequential)
           │
           ▼
        main branch
```

## Working Directory Configuration

### Solo Agent
- A custom `workDir` can be specified when hiring an agent (Browse button opens native macOS folder picker via gateway, or paste full path)
- If not specified, the built-in default workspace is used (gateway's `defaultWorkspace`)
- `workDir` is stored in gateway's `agentWorkDirs` map and passed as `repoPath` with every `RUN_TASK`
- The `PICK_FOLDER` command triggers a native macOS folder dialog (`osascript` → `choose folder`), returns full path via `FOLDER_PICKED` event

### Team Mode
- A custom `workDir` can be specified when creating a team (parent directory for projects)
- On `APPROVE_PLAN`, the gateway runs `git init` + initial commit, then creates a unique project subdirectory inside this directory
- All team members share the same `teamProjectDir`
- If not specified, `config.defaultWorkspace` is used

### Priority Order
```
RUN_TASK repoPath > agent workDir > team workDir > config.defaultWorkspace
```

## Layer 1: Git Worktree Isolation (Conflict Prevention)

### Principle
Each dev agent works in its own git worktree, physically isolating the filesystem. Even if an agent ignores conventions, it cannot affect other agents' files. Git enforces isolation at the branch level.

### When Worktrees Are Created

| Scenario | Worktree? | Created By |
|----------|-----------|------------|
| Solo agent, unique workDir | No | — |
| Solo agent, shares workDir with another solo agent | Yes (auto) | `orchestrator.ts` detects neighbor |
| Team dev agent (delegated by leader) | Yes | `delegation.ts` on delegation |
| Team leader | No | — (leaders don't write code) |
| Team reviewer | No | — (reviews on main branch) |

### Team Mode Flow
1. On `APPROVE_PLAN`, gateway creates project dir → `git init` → initial commit
2. Leader delegates tasks → `delegation.ts` creates worktree per dev agent:
   ```bash
   git worktree add .worktrees/<agentId>-<taskId> -b agent/<name>/<taskId>
   ```
3. Each dev agent works in its own worktree (isolated cwd)
4. On task completion: auto-merge back to main via `git merge --no-ff`
5. Reviewer reviews on main branch (after merge)
6. Direct fix loop: dev works on main (worktree already merged)

### Solo Multi-Agent Flow
1. First solo agent starts in the workDir directly (occupies main branch)
2. Second solo agent targeting the same workDir → `orchestrator.ts` detects the neighbor via `hasSoloNeighbor()` → auto-creates worktree
3. On completion: merge back to main
4. Requires workDir to be a git repo (otherwise no isolation)

## Layer 2: Conflict Detection (Pre-merge Safety)

### Approach
Uses native `git merge-tree --write-tree` for dry-run conflict detection before merging. No external tools required (needs git 2.38+).

### Implementation
Located in `packages/orchestrator/src/worktree.ts`:
```typescript
export function checkConflicts(workspace: string, branch: string): string[] {
  // git merge-tree --write-tree does a dry-run merge
  // Returns list of conflicting file paths, or empty array if clean
  execSync(`git merge-tree --write-tree HEAD "${branch}"`, { cwd: workspace });
}
```

### Trigger Points
- Called automatically in `delegation.ts` after each dev agent completes a task, before merging
- If conflicts detected:
  - Worktree directory removed (branch kept for manual resolution)
  - `worktree:merged` event emitted with `success: false` and `conflictFiles`
- If clean: normal merge proceeds via `mergeWorktree()`

### Cleanup on Conflict
- `removeWorktreeOnly()` removes the worktree directory but keeps the branch
- The branch can be manually merged later: `git merge agent/<name>/<taskId>`

## Layer 3: Activity Board (Real-time Awareness)

### Event Protocol
```typescript
interface AgentActivityEvent {
  type: "agent:activity";
  agentId: string;
  agentName: string;
  intent: string;              // Task description (first 200 chars)
  phase: "started" | "completed";
  touchedFiles?: string[];     // Files being modified
  exports?: string[];          // New interfaces/functions available
  needs?: string[];            // Dependencies needed
}
```

### Current Implementation
- `agent:activity` event emitted on delegation start and task completion in `delegation.ts`
- Events forwarded and logged by gateway
- Gateway logs: `[Activity] AgentName [started/completed]: intent...`

### Planned (Phase 5)
- Inject other agents' activity summaries into current agent's system prompt
- `exports`/`needs` dependency graph for interface contract broadcasting
- File ownership map for soft coordination

## Console Mode (UI)

A toggle button on the left edge of the chat sidebar expands it to full screen, hiding the PixiJS office scene to save GPU/CPU resources.

- **Collapsed**: Arrow button `‹` on sidebar left edge, pointing left
- **Expanded**: Full screen chat, arrow flips to `›`, button at screen left edge with right-side rounded corners
- Office scene is unmounted (not just hidden) when in console mode

## Implementation Status

| Phase | Content | Status |
|-------|---------|--------|
| Phase 1 | Working directory config (workDir on CREATE_AGENT/CREATE_TEAM, PICK_FOLDER native dialog) | Done |
| Phase 2 | Git worktree isolation (team delegation + solo neighbor detection) | Done |
| Phase 3 | Conflict detection (git merge-tree dry-run before merge) | Done |
| Phase 4 | Activity Board (agent:activity event on delegation start/complete) | Done |
| Phase 5 | Exports/Needs dependency graph + prompt injection | Planned |

## Key File Index

| File | Responsibility |
|------|---------------|
| `packages/shared/src/commands.ts` | Command protocol — `workDir` on CREATE_AGENT/CREATE_TEAM, `PICK_FOLDER` command |
| `packages/shared/src/events.ts` | Wire events — `FOLDER_PICKED` event for native folder dialog response |
| `packages/orchestrator/src/types.ts` | Internal events — `AgentActivityEvent`, `WorktreeCreatedEvent`, `WorktreeMergedEvent` |
| `packages/orchestrator/src/worktree.ts` | Git worktree CRUD — `createWorktree`, `mergeWorktree`, `removeWorktree`, `removeWorktreeOnly`, `checkConflicts` |
| `packages/orchestrator/src/delegation.ts` | Team delegation — worktree creation per dev agent, merge on completion, conflict check, activity broadcast |
| `packages/orchestrator/src/orchestrator.ts` | Orchestrator — solo agent neighbor detection (`hasSoloNeighbor`), worktree lifecycle, config passthrough to DelegationRouter |
| `packages/orchestrator/src/agent-session.ts` | Agent session — `worktreePath`/`worktreeBranch` storage, `currentWorkingDir` getter, CLI cwd resolution |
| `apps/gateway/src/index.ts` | Gateway — `agentWorkDirs` map, `teamWorkDir`, `git init` on APPROVE_PLAN, `PICK_FOLDER` handler (osascript), event forwarding |
| `apps/gateway/src/config.ts` | Default workspace resolution |
| `apps/web/src/app/office/page.tsx` | UI — HireModal/HireTeamModal with Browse button, console mode toggle |
| `apps/web/src/store/office-store.ts` | Store — `folderPickCallbacks` for PICK_FOLDER async response, `FOLDER_PICKED` handler |

## Rejected Approaches

| Approach | Reason |
|----------|--------|
| CRDTs (Yjs/Automerge) | AI agents write entire files, not character-by-character edits — wrong abstraction level |
| Python frameworks (MetaGPT/CrewAI) | Not Node.js native, and they don't solve file conflicts |
| Pure file locking (no worktree) | LLM agents are unpredictable — they may ignore locks and write files directly |
| Custom merge algorithms | Git's three-way merge is already optimal — no need to reinvent the wheel |
| External clash CLI | Native `git merge-tree` achieves the same goal without extra dependencies |
