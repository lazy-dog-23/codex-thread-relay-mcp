---
name: autonomy-report
description: Summarize the current autonomy state for the thread and Inbox without changing code.
---

# autonomy-report

Use this skill when the user wants a concise status update from the automation run.

## Responsibilities

- Read the latest autonomy state, recent verification result, and journal entry.
- For `汇报当前情况`, run `codex-autonomy status` from the repo root first; only use `codex-autonomy report` when the user explicitly asks for a detailed result summary.
- If the status output warns `git_runtime_probe_deferred` or `background_runtime_probe_deferred`, run `git status --short` from the repo root before trusting readiness; treat unmanaged diffs from that direct Git check as the effective blocker.
- Summarize the current goal, current task, latest verify/review outcome, latest commit, blockers, and why the loop is idle when nothing ran.
- Bind every summary to `report_thread_id`; treat the originating thread as the sole operator-facing surface.
- Quote `automation_state`, `ready_for_automation`, `next_automation_reason`, `report_thread_id`, `current_thread_id`, `thread_binding_state`, and `thread_binding_hint` directly from the latest CLI output instead of inferring from older observations.
- Treat normal success as a heartbeat summary, and surface blocked, review_pending, commit failure, or other failure states immediately.
- Keep the report short and actionable.

## Guardrails

- Do not modify business code.
- Do not change task state unless the reporting workflow explicitly owns it.
- Do not invent commit details or review conclusions.
- Do not repeat stale `doctor` blockers unless the latest `codex-autonomy status` or `codex-autonomy report` output still reports them.
- Do not report `ready_for_automation=true` when runtime Git probes were deferred and a direct `git status --short` shows unmanaged repo drift.
- If `thread_binding_state=bound_to_other`, say this thread is not the bound operator thread and stop instead of pretending the current thread owns the repo surface.
