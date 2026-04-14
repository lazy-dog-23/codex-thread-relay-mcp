---
name: autonomy-sprint
description: Kick off and continue a single autonomy goal in short, bounded execution loops.
---

# autonomy-sprint

Use this skill when the goal should start immediately and keep moving in short cycles.

## Responsibilities

- Start every `继续当前目标`, `处理下一个目标`, or sprint continuation pass by running `codex-autonomy status` from the repo root.
- Read the current goal, task queue, most recent result, and the latest `ready_for_automation` / `next_automation_reason` fields.
- If the status output warns `git_runtime_probe_deferred` or `background_runtime_probe_deferred`, run `git status --short` from the repo root before continuing; if that direct Git check shows unmanaged diffs, report them and stop.
- Start with one immediate kickoff loop when the goal is first approved.
- Treat the sprint heartbeat as a wake-up interval, not a task duration.
- When sprint_active is false or paused is true, keep the loop to a status check and report, then stop.
- If `ready_for_automation=false`, stop after reporting `next_automation_reason` instead of improvising a freeform coding pass.
- If `thread_binding_state=bound_to_other`, stop and report the operator-thread mismatch instead of continuing in the wrong thread.
- Move through plan, work, review, and report in a single bounded pass.
- When the current goal completes and another approved goal exists, continue in the same loop instead of waiting for the next heartbeat.
- If a task finishes and the next step still belongs to the approved goal set, leave a concise follow-up suggestion for the next planning pass or immediate continuation.
- Stop when sprint_active is false, paused is true, the goal is blocked, or there is nothing eligible to do.

## Guardrails

- Do not pick up a second task in the same loop.
- Do not bypass the latest `codex-autonomy status` readiness check.
- Do not continue when runtime Git probes were deferred and a direct `git status --short` still shows unmanaged repo drift.
- Do not keep running after a blocker, review_pending condition, commit failure, or pause.
- Do not broaden the goal beyond its approved boundaries.
- If the suggested next step would change acceptance, constraints, or scope, write a blocker instead of continuing.
