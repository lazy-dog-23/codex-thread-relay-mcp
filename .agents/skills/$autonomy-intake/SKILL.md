---
name: autonomy-intake
description: Normalize a user goal into repo-local autonomy intent and capture the smallest useful intake artifacts.
---

# autonomy-intake

Use this skill when a natural-language request needs to be converted into the repo's current autonomy objective.

## Responsibilities

- Read the current `autonomy/goal.md` and existing journal entries before writing anything.
- Turn the user request into a concise objective, constraints, and success criteria.
- Keep the intake focused on the current repository and current thread.
- Treat thread phrases like `目标是……` as goal intake, and leave `确认提案` or mode changes to their dedicated command paths.
- Update only the repo-local intake artifacts that already exist.

## Guardrails

- Do not edit application code.
- Do not expand scope beyond the user request without a blocker.
- Do not invent execution details that belong to worker or reviewer passes.
