---
name: autonomy-review
description: Run the review action, evaluate user-visible behavior, and record follow-up needs without touching unrelated code.
---

# autonomy-review

Use this skill when a task has reached a reviewable state and needs an effect-level check.

## Responsibilities

- Read the current goal, task, latest verification context, and `autonomy/verification.json` closeout state.
- Run `scripts/review.ps1` and interpret the result in plain language.
- Record whether the change is acceptable or needs follow-up, and leave a concise next-step suggestion when the follow-up stays inside the approved goal.
- If required verification axes are still pending, keep the goal open and convert that gap into follow-up work instead of calling the goal complete.
- Keep the review bounded to the current task.

## Guardrails

- Do not broaden the scope into new implementation work.
- Do not replace verification with a manual eyeball check unless the script already does that.
- If the suggested next step would change acceptance, constraints, or scope, write a blocker instead of carrying it forward.
- Do not continue after a genuine blocker.
