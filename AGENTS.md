# Repo Control Surface

这份仓库把控制面收口在 repo 内。任何自动化工作都必须先读这里，再读对应 skill 和 `autonomy/*` 状态文件。

## 硬规则

1. 一次只处理一个任务，禁止并行拿多个任务。
2. `scripts/verify.ps1` 是 worker 的唯一验收门。
3. 只改必要源文件和 `autonomy/*`，不要扩散到无关区域。
4. 遇到歧义、冲突、缺失上下文时，先写 blocker，再停止。
5. 手工 `commit`、`push`、`deploy` 统统禁止；自动提交只允许自治流程在 `codex/autonomy` 分支上执行。
6. 所有写入 `autonomy/*` 的动作，先拿 `autonomy/locks/cycle.lock`。
7. `autonomy/*` 下的 JSON 必须原子写入，时间统一用 UTC ISO 8601，路径统一用 repo-relative forward-slash。
8. 由于 repo 默认 `approval_policy=never`，禁止 destructive 或高影响操作：不得执行 force push、history rewrite、批量删除、越界写入、凭据变更、部署、外部系统副作用；需要这类动作时必须先写 blocker 并停止。

## 运行约定

- Planner 只维护 `queued` / `ready` 窗口，最多保留 5 个 `ready` 任务，不修改业务代码。
- Worker 每轮只拿一个 `ready` 任务，做最小改动，跑验证，更新状态后停止。
- 第一次验证失败记为 `verify_failed`；第二次失败或真实歧义记为 `blocked` 并新增 blocker。
- dirty background worktree 立即置为 `review_pending` 并停机。
- Reviewer 运行 `scripts/review.ps1` 做效果检查和结论收口，不扩大任务范围。
- Reporter 只有异常、blocked、review_pending、commit 失败等情况立即回线程；正常成功按 heartbeat 汇总，详细运行记录留在 Inbox 和 journal。
- Sprint runner 的 heartbeat 只是唤醒间隔，不是任务时长；每次唤醒只推进单个任务闭环，当前 goal 完成且存在下一个 approved goal 时同轮直接接续。
- `sprint_active=false` 或 `paused=true` 时只做状态检查和汇报，不做新的 plan/work/review 推进。
- Sprint runner 遇到 blocker、review_pending 或无任务时停下。
- Worker、Reviewer 或 Sprint runner 如果生成了“下一步建议”，只允许目标内 follow-up 自动入队；一旦改变验收、约束或范围，必须写 blocker 等线程确认。
- `autonomy/verification.json` 是 closeout gate；体检/安全/健壮性类 goal 在 required verification axis 清零前不得完成。
- 非 Git 目录允许 `bootstrap`，但不允许进入可运行 automation 态。

## 线程入口

- 原线程是唯一操作入口，`report_thread_id` 是所有摘要和异常回传的锚点。
- 线程内的自然语言动作固定收口为：`把 auto 装进当前项目`、`目标是……`、`确认提案`、`用冲刺模式推进这个目标`、`用巡航模式推进这个目标`、`汇报当前情况`、`暂停当前目标`、`继续当前目标`、`处理下一个目标`、`合并自治分支`。
- `汇报当前情况` 必须先运行 `codex-autonomy status`；只有明确要求详细结果时才运行 `codex-autonomy report`，并且以最终命令输出里的 `automation_state`、`ready_for_automation`、`ready_for_execution`、`goal_supply_state`、`next_automation_step`、`next_automation_reason`、`report_thread_id`、`current_thread_id`、`thread_binding_state`、`thread_binding_hint` 为准。若状态里出现 `git_runtime_probe_deferred` 或 `background_runtime_probe_deferred`，还必须直接运行一次 `git status --short` 再判断真实 blocker。
- `继续当前目标`、`处理下一个目标`、`用冲刺模式推进这个目标` 在执行前必须先运行 `codex-autonomy status`；如果 `ready_for_automation=false`，原样汇报 `next_automation_reason` 并停止；如果 `ready_for_execution=false`，则严格按 `next_automation_step` 收口：`plan_or_rebalance` 只做一轮规划/收口，`await_confirmation` 只汇报待确认并停止，只有 `execute_bounded_loop` 才能进入业务代码闭环。若状态里出现 `git_runtime_probe_deferred` 或 `background_runtime_probe_deferred`，还必须直接运行一次 `git status --short`，发现 unmanaged drift 就停止。
- 如果 `thread_binding_state=bound_to_other`，当前线程不是 operator thread；必须明确报告 mismatch 并停止，不得静默沿用旧 `report_thread_id` 继续。
- `goal.md` 只镜像当前 active goal；真正的目标队列和批准边界以 `goals.json`、`proposals.json`、`tasks.json` 为准。

## Skills

- `.agents/skills/$autonomy-plan/SKILL.md`
- `.agents/skills/$autonomy-work/SKILL.md`
- `.agents/skills/$autonomy-intake/SKILL.md`
- `.agents/skills/$autonomy-review/SKILL.md`
- `.agents/skills/$autonomy-report/SKILL.md`
- `.agents/skills/$autonomy-sprint/SKILL.md`

## Shared Environment

- `.codex/environments/environment.toml` 由 repo 共享，包含 Windows setup script，以及 `verify`、`smoke` 和 `review` 三个 actions。
