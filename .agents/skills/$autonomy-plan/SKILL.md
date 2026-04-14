---
name: autonomy-plan
description: Read the active goal queue and state, keep the ready window within policy, and update autonomy files without touching business code.
---

# autonomy-plan

Use this skill when you need to plan the next automation cycle for the repo control plane.

## Responsibilities

- Read `autonomy/goal.md`, `autonomy/goals.json`, `autonomy/proposals.json`, `autonomy/tasks.json`, `autonomy/state.json`, `autonomy/blockers.json`, `autonomy/results.json`, and `autonomy/verification.json`.
- Keep at most 5 tasks in `ready` for the current active goal.
- If a goal is still `awaiting_confirmation`, update only `autonomy/proposals.json` and do not materialize tasks yet.
- If the goal is `approved` or `active`, rebalance only inside that approved boundary.
- If a worker, reviewer, or sprint loop leaves a follow-up suggestion that still fits the approved goal, convert it into proposal or task queue adjustments.
- Acquire `autonomy/locks/cycle.lock` before writing `autonomy/*`.
- Write `autonomy/*.json` via atomic temp-file then rename semantics.
- Update only autonomy state, proposal, result, and journal entries.

## Guardrails

- Do not edit business code.
- Do not take implementation ownership of a worker task.
- Do not bypass blockers or dependencies.
- Do not expand scope, change acceptance, or relax constraints without a blocker.
- If a suggested next step would cross the approved goal boundary, write a blocker instead of promoting it.
- If the next step is unclear, write a blocker and stop.

## Output

- Reconciled task queue state.
- Updated cycle status.
- New blocker records when needed.
- A journal entry for the run.
