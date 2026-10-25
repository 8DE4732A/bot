# 六期设计：Durable 调度与任务生命周期

> 状态：**已实现**（2026-10-25；M0–M4 落地，216 tests 全绿 + 真实 provider 冒烟）
> 基线：`@earendil-works/pi-durable` 1.4.0（durable sleeps / wake / crash-loop guard / `retryTask` / `TaskInspection.state`）
> 关联：`docs/PHASE5-DESIGN.md`（工作区技能/记忆）、`src/scheduler/`、`src/core/agent-manager.ts`

## 1. 背景与目标

当前定时任务由宿主进程的 `SchedulerManager` 每秒轮询 `scheduled_tasks` 表实现：

- `src/scheduler/index.ts:9` `TICK_MS = 1000`
- `src/scheduler/index.ts:33` `setInterval(() => void this.tick(), TICK_MS)`
- `src/scheduler/index.ts:56` `tick()` 先做覆盖索引探针，再对到期任务 `reserve` + 异步 `execute`
- 触发执行走 `AgentManager.chat(agentId, scheduler:<taskId>, prompt)`
- 重启后的 catch-up 依赖 `next_run_at <= now` 的轮询天然覆盖

1.4.0 提供了任务级持久睡眠：

- `runtime.sleepUntil(until, checkpoint, ctx)`
- `HarnessOptions.setTimer` / `Harness.wake()`（`onWake` 本项目不使用，见 §5.4）
- `TaskInspection.state.kind === "sleeping" | "blocked"`
- `settings.restartLimit` + `Harness.retryTask(id)`
- `HarnessOptions.models/settings` 函数、`onReport(ReportInfo)`

六期目标：

1. **去掉 1 秒轮询**：定时任务在精确的 `nextRunAt` 被唤醒，空闲时不产生周期性 SQLite 查询。
2. **跨重启**：任务在 sleeping 状态可安全退出/重启，恢复后从 checkpoint 继续，不丢触发点。
3. **可观测与可恢复**：每次触发有 run ledger；crash-loop 任务被 park，可在管理台查看/重试。
4. **保持现有语义**：once/every/cron、通知目标、手动触发、软删除、Agent 归属、drain 行为不回归。

非目标（本期不做）：

- 多实例分布式调度（仍由 gateway.lock 保证单实例）。
- 重写渠道通知协议；继续使用 `scheduler.completed` 事件 + `NotificationDispatcher`。
- Telemetry 后端（OTel/SQLite exporter）——作为 6.x 可选项。
- deferred tools / codemode / 图片读取等 Agent 能力升级——另立主题。

## 2. 现状约束

### 2.1 业务库与会话库分离

- 业务库 `bot.sqlite`：`scheduled_tasks` 等（`DatabaseManager` / `DatabaseStore`）
- 会话库 `conversations.sqlite`：pi-durable 的 conversations/tasks/documents（框架自管）

两库无跨库事务。六期必须接受：

- 业务任务状态与 durable task 状态不能原子提交；
- 采用 **唯一 run ledger + requestId** 实现 at-least-once + 去重，而不是追求 exactly-once。

### 2.2 当前执行链路

`SchedulerManager.execute()`：

1. `incrementScheduledTaskRun` 原子递增 `run_count`
2. `AgentManager.chat(...)`（会话级串行锁 + 持久 conversation）
3. 写回 `last_run_at/last_status/last_result`
4. 发布 `scheduler.completed` → `NotificationDispatcher` 推送渠道

六期保留这条链路，只替换“何时触发”。

### 2.3 1.4.0 已做的适配

- `durableBusyCount()` 已排除 `sleeping` / `blocked`（`src/core/agent-manager.ts`）；六期还必须排除 `kind === "bot.scheduled-prompt"` 的 running/ready 任务，否则一个慢定时任务会全局阻塞 WS 队列。
- 已新增 `GET /api/durable-tasks` / `POST /api/durable-tasks/retry` 与管理台 Durable 任务面板。
- 已接入 `onReport` → `agent.report` 审计；`settings` 函数按模型窗口派生压缩阈值。

### 2.4 关键框架事实

- 任务定义：`defineTask({ name, version, initial, phases, abort })`
- 阶段切换：`runtime.commit(() => ({ status: "running", checkpoint: { phase: "next", ... } }), ctx)`
- 持久睡眠：`runtime.sleepUntil(until, checkpoint, ctx)`；`sleeping` 任务不持有 invocation
- 终止：`{ status: "terminal", outcome: { status: "completed" | "failed" | "aborted", ... } }`
- 重复提交去重：`Conversation.submit({ type: "input", content, requestId })`；同一 conversation 内相同 `requestId` 返回既有 submission；`unanswered` 也会返回既有记录
- `Harness.abortTask(id, ctx)` 返回 `"marked" | "terminal"`，**不保证 abort handler 已执行到 terminal**；需要 `waitForTask(id)` 或 `aborting` 状态
- framework 在 phase 决定提交/切换时 abort invocation 的 signal；不要把 `runtime.signal` 传播给已提交的生成
- `Harness.wake()`：`{ active: boolean, at?: number }`
- `Harness.retryTask(id, ctx)`：只对 `restartLimit` park 的任务有意义
- Schema v2：打开 `conversations.sqlite` 自动迁移且不可回退（升级 1.4.0 的前置条件）

## 3. 方案选择

### 方案 A：单个 durable coordinator 任务

一个长期任务循环：

```
wait: sleepUntil(earliest nextRunAt, checkpoint)
tick: 扫描到期业务任务 → reserve → 触发执行 → 回到 wait
```

优点：

- 只创建一个 durable task，改动小
- 与现有 `SchedulerManager.tick()` 逻辑最接近

缺点：

- 新建/编辑一个 5 秒后触发的任务时，coordinator 正在长睡眠，无法被精确打断；只能：
  - 限制单次睡眠上限（退化为 30s/60s 轮询），或
  - `abortTask` 后重建 coordinator（本质上仍需要复杂的生命周期管理）
- 所有任务共享一个 crash-loop 计数；一个坏任务会 park 整个调度器
- 无法在管理台按业务任务定位 durable task 状态

**不推荐。**

### 方案 A′：单个 coordinator + 宿主 worker/outbox

coordinator durable task 只负责：

```
wait: sleepUntil(earliest nextRunAt)
tick: 把到期任务写入业务 outbox（due queue）→ 回到 wait
```

实际的 `AgentManager.chat` 由宿主 worker 从 outbox 取出执行。

优点：

- 只有一个 durable task，避免每个 phase 内重入 Harness
- outbox 可以承载重试/lease/通知，任务生命周期与聊天生成解耦

缺点：

- 新建/编辑一个即将触发的任务时，coordinator 仍在长睡眠；没有“唤醒/缩短 sleep”的 API，只能 abort/rebuild coordinator 或设置睡眠上限，编辑语义仍复杂
- outbox worker 需要自己的唤醒机制：要么轮询，要么依赖 coordinator tick，而 tick 本身又被长睡眠限制
- 一个 coordinator crash-loop 会影响全部调度
- 管理台无法按业务任务看到独立 durable 状态

结论：A′ 是可行的退路，但会把“精确唤醒”问题转移到 coordinator 的编辑/重建与 outbox worker 的唤醒上；在本项目“任务数量少、需要按任务观测”的场景下，方案 B 更直接。

### 方案 B（推荐）：每个业务任务对应一个 durable task

`1 scheduled_task ↔ 1 durable task`：

- 任务 input 只保存 `{ scheduledTaskId }`，每次 phase 从业务库读取最新配置
- `wait` phase 精确 `sleepUntil(next_run_at)`
- `run` phase 通过现有 `SchedulerManager.execute` 链路触发
- 新建 → 创建 durable task；编辑/禁用/删除 → abort 并重建/清除
- 每个任务独立 crash-loop、独立 blocked/retry、独立状态可见

优点：

- 精确唤醒，无需轮询上限
- 任务级隔离与可观测
- 与 `restartLimit` / `retryTask` 语义自然对齐

缺点：

- 需要 durable task 生命周期管理（创建、abort、reconcile）
- 业务库与 durable 库的一致性需要幂等设计
- durable task 数量与业务任务数量同阶（通常很小）

**结论：采用方案 B。**

### 方案 C：保留轮询，仅把 1s 调大

作为降级/回滚路径保留，不作为六期主方案。

## 4. 总体架构

```
schedule_create / admin POST
        │
        ▼
DatabaseStore.saveScheduledTask  ──►  scheduled_tasks (durable_task_id)
        │
        ▼
SchedulerRuntime.ensureDurableTask(taskId)
        │  harness.commit(tx => tx.createTask(ScheduledPromptTask, {scheduledTaskId}, {
        │      ownership: { kind: "conversation" },
        │      conversationId: schedulerOwnerConversationId,
        │      background: true,
        │  }))
        ▼
ScheduledPromptTask (durable)
   wait phase ── sleepUntil(next_run_at)
        │
        ▼
   run phase ── SchedulerManager.executeReserved(...)
        │           ├─ 业务库唯一 run ledger（幂等）
        │           ├─ AgentManager.chat(..., { requestId })
        │           └─ last_* 回写 + scheduler.completed
        ▼
   wait phase（下一次 next_run_at）
```

### 4.1 所有者 conversation

durable task 需要一个 conversation 作为 owner：

- 使用一个固定的 **ownerless** conversation：`scheduler-owner`
- 首次需要时创建：`harness.createConversation({ ownership: { kind: "ownerless" } }, ctx)`
- 把 id 写入 `system_config.scheduler_owner_conversation_id`
- 所有调度任务以 `ownership: { kind: "conversation" }, conversationId: ownerId, background: true` 创建

`background: true` 的作用：

- 不参与普通 idle 等待
- 不随业务会话 abort/reset 级联
- 不在用户会话中产生可见 transcript

该 conversation 不绑定 Agent；`ScheduledPromptTask` 的 phase 不调用 `runtime.agent()` / `runtime.env()`，只访问业务库并调用宿主 runner。

### 4.2 系统扩展注册

新增：

- `src/scheduler/durable-task.ts`：`ScheduledPromptTask` 定义 + runner 注入接口
- `src/scheduler/durable-runtime.ts`：`SchedulerRuntime`（ensure/abort/reconcile/run）
- `src/scheduler/system-extension.ts`：`defineExtension({ name: "system-scheduler", tasks: [ScheduledPromptTask] })`

`AgentManager.init()` 像 `SkillsCatalog` / `WorkspaceContext` 一样显式 `registry.install(SchedulerSystemExtension)`：

- 不进入 `SkillRegistry`（不出现在 Agent 技能勾选列表）
- 任务定义对所有 conversation 可见（registry `tasks` 按名字解析）

为避免循环依赖：

- `AgentManager` 只 import `system-extension.ts`（不含 AgentManager import）
- `SchedulerRuntime` 通过注入的 `SchedulerRunner` 回调调用 `AgentManager.chat`
- `scheduler/index.ts` 在启动时 `setSchedulerRunner(...)`

与五期 `agent-scope.ts` 的注入模式一致。

## 5. 详细设计

### 5.1 任务定义

```ts
type ScheduledPromptInput = { scheduledTaskId: string };

type ScheduledPromptCheckpoint =
  | { phase: "wait" }
  | {
      phase: "run";
      scheduleVersion: number;
      runKey: string;
      scheduledFor: number;
      /** 取消 chat 失败的重试计数；按 (runKey, lease_fence) 独立计数 */
      cancelAttempts?: number;
      cancelFence?: number;
    };

type ScheduledPromptResult =
  | { reason: "deleted" | "disabled" | "done" | "superseded" | "cancelled" };

export const ScheduledPromptTask = defineTask<
  ScheduledPromptInput,
  ScheduledPromptCheckpoint,
  ScheduledPromptResult
>({
  name: "bot.scheduled-prompt",
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    async wait(task, runtime, context) {
      const row = store.getScheduledTask(task.input.scheduledTaskId);
      if (!row || row.deletedAt) return terminal(runtime, context, "deleted");
      if (!row.enabled) return terminal(runtime, context, "disabled");

      const next = row.nextRunAt;
      if (next === undefined) return terminal(runtime, context, "done");
      if (next > runtime.now()) {
        return runtime.sleepUntil(next, { phase: "wait" }, context);
      }

      // 关键顺序：先把触发点 identity 写入 durable checkpoint，再进入 run。
      // 这样即使业务库 reserve 前后崩溃，重放也能从 checkpoint 重建 runKey。
      const runKey = `schedule:${task.input.scheduledTaskId}:${row.scheduleVersion}:${next}`;
      await runtime.commit(
        () => ({
          status: "running",
          checkpoint: {
            phase: "run",
            scheduleVersion: row.scheduleVersion,
            runKey,
            scheduledFor: next,
          },
        }),
        context,
      );
    },
    async run(task, runtime, context) {
      const cp = task.state.checkpoint;
      try {
        const outcome = await runScheduledPrompt(
          task.input.scheduledTaskId,
          cp.runKey,
          cp.scheduledFor,
          cp.scheduleVersion,
        );
        if (outcome.kind === "superseded") {
          return terminal(runtime, context, "superseded");
        }
      } catch (err) {
        // 启动 gate 未就绪：保留同一 checkpoint，1s 后重试
        if (err instanceof SchedulerNotReady) {
          return runtime.sleepUntil(runtime.now() + 1_000, cp, context);
        }
        // poisoned 是 fail-closed：不 cancel、不累计 attempts、不重试
        if (err instanceof ConversationPoisoned) {
          recordPoisonedAudit(task.input.scheduledTaskId, cp.runKey);
          return runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "failed", error: { message: "conversation_poisoned" } },
            }),
            context,
          );
        }
        runtime.report(err);
        // 进入取消前先读取当前 run 的 fence（按 runKey 精确读取）
        const fence = await currentRunFence(task.input.scheduledTaskId, cp.runKey);
        // phase 内只取消并等待 chat，不调用 abortTask（避免 phase 等自己）
        const cancelled = await cancelChat(task.input.scheduledTaskId, 30_000);
        if (cancelled) {
          // 成功取消后清零计数，避免下一次失败继承旧 attempts
          return runtime.sleepUntil(
            runtime.now() + 30_000,
            { ...cp, cancelFence: fence, cancelAttempts: 0 },
            context,
          );
        }
        // cancelAttempts 必须绑定当前 lease_fence；接管后 fence 变化则从 0 计数
        const base = cp.cancelFence === fence ? (cp.cancelAttempts ?? 0) : 0;
        const attempts = base + 1;
        if (attempts >= 5) {
          // 持续无法确认 chat 退出：标记 conversation poisoned，禁止复用/自动重建
          // 写 poison 必须带当前 fence，旧 fence 不得 poison 新 owner
          markConversationPoisoned(task.input.scheduledTaskId, fence);
          return runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "failed", error: { message: "chat_cancel_timeout" } },
            }),
            context,
          );
        }
        return runtime.sleepUntil(
          runtime.now() + 30_000,
          { ...cp, cancelFence: fence, cancelAttempts: attempts },
          context,
        );
      }

      const row = store.getScheduledTask(task.input.scheduledTaskId);
      if (!row || row.deletedAt) return terminal(runtime, context, "deleted");
      // 编辑代际已变化：旧 task 不再负责新的触发点
      if (row.scheduleVersion !== cp.scheduleVersion) {
        return terminal(runtime, context, "superseded");
      }
      // once 完成：reserve 已置空 next_run_at，但 enabled 的关闭由 finishRun 负责。
      // 必须先判断 done，再判断 disabled，否则会把 done 误报为 disabled。
      if (row.nextRunAt === undefined) return terminal(runtime, context, "done");
      if (!row.enabled) return terminal(runtime, context, "disabled");

      const next = row.nextRunAt;
      if (next > runtime.now()) {
        return runtime.sleepUntil(next, { phase: "wait" }, context);
      }
      // next_run_at 仍在过去（例如执行期间被编辑）：先退避，避免热循环
      return runtime.sleepUntil(runtime.now() + 60_000, { phase: "wait" }, context);
    },
  },
  async abort(task, runtime, context) {
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted", reason: "aborted" } }),
      context,
    );
  },
});
```

说明：

- 代码中的 `terminal(runtime, context, reason)` 是提交
  `{ status: "terminal", outcome: { status: "completed", result: { reason } } }` 的本地 helper。
- `wait` 每次从业务库读最新值，prompt/name/notify/agent 的修改无需重建任务。
- **只有调度字段 / enabled 变化才递增 `schedule_version` 并重建 durable task**（见 5.3）。
- `runKey` 只由稳定的触发点决定：`taskId + scheduleVersion + scheduledFor`。name/prompt 编辑不改变 runKey。
- `scheduleVersion` 在 checkpoint 中固定；旧 task 醒来发现业务行版本变化会直接 terminal，不会执行新配置。
- `run` 前先把 run checkpoint 持久化，再调用 runner；这是双库半提交的核心顺序约束（见 5.2）。
- `runScheduledPrompt` **不接收 `runtime.signal`**：framework 在 phase 结束时会 abort invocation，不能把该 signal 传播给已提交的生成。

### 5.2 触发执行与幂等

新增 `SchedulerRuntime.runScheduledPrompt(taskId, runKey, scheduledFor, scheduleVersion)`：

```ts
type RunOutcome =
  | { kind: "completed"; runId: string; answer: string }
  | { kind: "already-done"; runId: string; answer: string }
  | { kind: "superseded" };
```

0. **前置条件**：`wait` phase 已经先把 `{phase:"run", scheduleVersion, runKey, scheduledFor}` 写入 durable checkpoint。runner 只消费 checkpoint，不再从当前 `next_run_at` 推导触发点。
1. **业务库 reserve（原子 + lease/fence）**
   - `DatabaseManager` 新增 `transaction(fn)`（`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`）
   - `reserveScheduledRun` 在同一事务内：
     - 读取 `scheduled_tasks`；若 `deleted_at` 或 `schedule_version != expected` → 返回 `superseded`（不写 ledger）
     - `INSERT OR IGNORE INTO scheduled_task_runs (..., run_key, request_id, schedule_version, status='running', lease_owner, lease_until, lease_fence)`
     - 插入成功：`run_count += 1`；`advanceSchedule=true` 时推进 `next_run_at`
       - `every/cron`：写入下一次时间
       - `once`：只把 `next_run_at` 置空，**暂不置 enabled=false**；由 `finishRun` 在成功终态里统一置 enabled=false/last_status=done/durable_state=done
     - 插入失败：返回既有 run（`done` → 复用结果；`running` → 检查 lease）
   - `lease_fence` 是单调递增整数：**只在接管时递增**；正常续租使用
     `UPDATE ... SET lease_until=? WHERE id=? AND lease_fence=? AND status='running'`，
     成功后 runner 保留原 fence；接管时先写新 fence，再让旧 runner 续租失败
   - 终态、outbox、last_* 更新都带当前 `lease_fence` 条件
   - 终态仲裁：**新 fence 的 owner 写主 status/outbox**；旧 owner 只能写
     attempt/audit，不能写主 status/outbox；若没有新 owner 接管，由 reconcile 统一写
     `aborted`；主 status 的 UPDATE 必须带 `lease_fence=? AND status='running'`
   - 续租失败（影响 0 行）→ 抛 `LeaseLost`，立即 `cancelRun` 取消当前 chat；
     旧 owner 不得再提交/通知
   - lease 规则：`lease_owner` 为进程 UUID；`lease_until = now + 120s`；run 期间每 30s 续期；续期失败立即取消当前 run；进程崩溃后由 reconcile 在 gateway.lock 下接管
2. **运行注册与取消（两阶段、可重入）**
   - `AgentManager` 增加 `activeChats: Map<taskId, { agentId, sessionId, promise, controller, submissionId? }>`：
     - `chat()` **进入即注册** `AbortController` 与完成 promise（在
       `getOrCreateConversation` 之前），`chatLocked` finally resolve
     - `chat()` 在入口、getOrCreateConversation 后、submit 前检查
       `controller.signal.aborted`；已取消则不再提交
     - key 使用稳定的 `taskId`（或 `scheduler:<taskId>`），不按当前业务 agentId 查
     - `abortSession` 只是包装；真正的取消走 `cancelChat(taskId)`：
       controller.abort() + conv.abort()（如果已有 conversation）
   - **外部 cancelRun(taskId, durableTaskId?)**（编辑/删除）：
     - 手动触发的 run 没有 durableTaskId：只执行 cancelChat + waitForChat/idle，
       不调用 abortTask；run ledger 写 `aborted`
     - 有 durableTaskId 时按下面顺序：
     1. 标记 per-task cancelIntent（幂等）
     2. `cancelChat(taskId)`：controller.abort + （若 conversation 已绑定）conv.abort
     3. `harness.abortTask(oldId)`（**不等待**）
     4. `await Promise.all([waitForChat(taskId, 30s), waitForTask(oldId, 30s)])`
     5. 重新读取 `harness.inspect()` + `conv.waitForIdle(5s)`，使用精确谓词确认：
        同一 conversation 下不得存在 `kind ∈ {"pi.generation","pi.tool"}` 且
        `status ∈ {"pending","running","waiting","sleeping","completing"}` 的任务；
        terminal 任务可以接受。同时不得有 placed/queued submission
        - **placed submission 不能靠 `submission.abort()` 清理**：1.4.0 对 placed
          返回 `already_placed`，只对 queued 有效
        - placed 仍未 settle / idle 未达成 → 进入 aborting/poisoned，不重建
     6. 只有 `waitForTask terminal && waitForChat resolved && waitForIdle succeeded
        && inspect 无 generation/placed/queued` 全部满足，才允许清 id/重建
   - 顺序要求：`cancelChat` 和 `abortTask` 必须在等待之前发出；不能先等 task
     terminal 再 abort chat，否则 task 可能已 terminal 而 generation 仍在写
   - **phase catch 内的 cancelChat(taskId)**：
     - 只 abort/等 activeChats（queued submission 可 abort；placed 走 conv.abort +
       waitForIdle），**不调用 abortTask/waitForTask**（phase 就是 task 自己，避免自等待）
     - 失败 5 次（每次 30s，按同一 fence）→ `markConversationPoisoned` + terminal failed
   - `waitForChat` 超时：保留 `durable_state='aborting'`，不清理 id、不重建；
     reconcile 继续取消/接管；不能把“已发起 abort”当作“chat 已结束”
   - `activeChats` 的 `submissionId` 在 `conv.submit` 成功后回填：
     - submit 前取消只 abort controller
     - queued：`submission.abort` / `abortSubmission`
     - placed：只能 `conv.abort` + `waitForIdle`，`already_placed` 不是清理成功
   - conversation 不存在时：只做 controller/queued 清理，不能视为 idle；重复调用
     `cancelChat` 必须幂等
3. **提交生成**
   - **conversation 绑定**：
     - 调度路径**不得调用会自动重建的 `getOrCreateConversation`**；使用
       `AgentManager.openSchedulerConversation(agentId, taskId, conversationId?)`：
       - 有 id：`harness.conversation(id)`；undefined → fail-closed，不创建、不覆盖 mapping
       - 无 id 且无 mapping：允许创建一次（`harness.createConversation` /
         `getOrCreateConversation`），随后在同一业务事务写
         `channel_sessions` + `scheduled_tasks.conversation_id`
       - mapping 存在但 task 字段为空 → backfill；task 有 id 但 mapping 缺失 →
         尝试按 id 打开，失败 fail-closed；两者不一致 → fail-closed
     - `channel_sessions` 的 `(channel_session, scheduler:<taskId>)` 唯一约束保证
       one-task-one-conversation
     - `schedulerConversationIds()` 以 owner conversation + 每个 task 的持久
       mapping 为准，不只依赖内存 activeRuns
   - `AgentManager.chat(agentId, "scheduler:<taskId>", prompt, undefined, {
       requestId: `sched:${taskId}:${runKey}`,
       conversationId: row.conversationId,
     })`
   - 相同 requestId 由 durable conversation 去重：进程崩溃后重跑不会重复提交用户输入
   - **回答历史幂等**：generation task 自己写入 assistant entry；`chatTurn` 只是
     `conv.commit(tx => tx.entry(AssistantEntry, settled.answer))` 读取该 entry
     （`src/core/agent-manager.ts:934`，`tx.entry` 是读，不是 append）。因此
     `requestId` 命中 + `tx.entry` 读取的组合不会重复写历史。设计验收必须覆盖
     “answer settled 后、ledger 终态前崩溃”的场景（见 §7）。
   - **chat 前二次版本校验**：reserve 成功后、提交 chat 前重新读取业务行；
     `schedule_version` 不一致 → `superseded`，不提交
4. **回写（禁止复活）**
   - 仅 lease owner + fence 执行条件更新：
     `UPDATE scheduled_task_runs SET status=?, result=?, error=?, ended_at=? WHERE id=? AND status='running' AND lease_fence=?`
   - `scheduled_tasks` 的 run 结果只更新 `last_*`，条件：
     `WHERE id=? AND deleted_at IS NULL AND schedule_version=?`
   - once 完成：
     `UPDATE ... SET enabled=0, next_run_at=NULL, last_status='done', durable_state='done'
      WHERE id=? AND deleted_at IS NULL AND enabled=1 AND schedule_version=?`
   - 删除/禁用写入的 `deleted_at/enabled/durable_state` 优先级更高；finishRun
     **绝不写 deleted_at / enabled=1 / next_run_at 的未来值**，0 行更新时只写
     ledger/outbox，不复活业务行
   - 仅当上述更新实际改变了一行时写入 outbox `pending`
5. **通知 outbox**
   - `scheduler.completed` 事件带 `runId`
   - 事件写入通知 outbox（`pending`），由 dispatcher 原子 claim；失败进入 `failed + next_attempt_at`，可被再次 claim
   - outbox 以 `runId` 唯一；进程崩溃后可从 outbox 恢复，不依赖进程内 LRU
   - 进程内 LRU 只作为快速路径，不作为唯一去重

**异常终态**：

- runner 捕获业务/模型错误后，必须用当前 fence 写 `status='error'` 并保留 `error`；
  写失败时抛 `RunFinalizeError`
- run phase 的 catch 只调用 `cancelChat`（abort activeChats + 清理 submission），
  不调用 abortTask；确认 chat 退出后才允许保留同一 checkpoint 30s 后重试
- `currentRunFence(taskId, runKey)` 必须按 `(task_id, run_key)` 读取当前
  `status='running'` 行的 `lease_fence`；不存在/非 running → 抛
  `LeaseLost`/`RunFinalizeError`，不得返回 0 或旧值
- 成功 cancel 后 checkpoint 写 `{ cancelFence: fence, cancelAttempts: 0 }`；
  失败才累加；接管后 fence 变化从 0 计数
- `cancelChat` 连续 5 次（每次 30s，按同一 `lease_fence`）无法确认 chat 退出 →
  标记 conversation poisoned + terminal failed（`chat_cancel_timeout`），禁止自动复用/重建；
  lease 接管后 fence 变化，`cancelAttempts` 从 0 重新计数
- 取消/删除中断 chat 后，写 `status='aborted'`（ledger CHECK 包含 aborted）
- 只有 `reserve → chat → 终态` 全部完成（或明确终态）后才允许推进到下一次 wait

`AgentManager.chat` 新增可选参数（保持现有第 4 个 `onChunk` 位置参数不变）：

```ts
chat(
  agentId: string,
  sessionId: string,
  userMessage: string,
  onChunk?: (chunk: ChatChunk) => void,
  options?: { requestId?: string; conversationId?: number },
): Promise<string>
```

- `conv.submit({ type: "input", content: userMessage, requestId }, ctx)`
- `conversationId` 指定时复用该 durable conversation；不存在则报错，不静默新建
- 不接收 `signal`；drain/取消由宿主显式调用 `abortSession` 或走现有 drain 上限。
- phase 结束不会误取消已提交的生成。
- 不改变现有调用方；默认无 requestId/conversationId

### 5.3 生命周期：创建 / 编辑 / 删除 / 启动对账

#### 创建

三条入口：

1. 模型工具 `schedule_create`（`src/scheduler/tools.ts`）
2. 管理台 `POST /api/scheduled-tasks`
3. 启动对账（历史任务）

保存业务行后调用：

```ts
await SchedulerRuntime.ensureDurableTask(task.id);
```

行为：

- 读取 `durable_task_id` / `durable_state`
- 若为空：创建 durable task，写回 id，`durable_state='active'`
- 若已有但 `harness.getTask(id)` 为 `undefined` 或 terminal：视为失效，重新创建
- 若已有且 `state.kind === "blocked"`：
  - `reason === "restart_limit"`：**不自动重建**，保留 blocked（管理台 retry 或编辑）
  - `missing_task` / `task_too_old` / `migration_failed`：先清理旧 live task（abort/等待终态），再重建
- 所有创建/编辑/删除/启用操作进入 **per-task 串行队列**（`SchedulerRuntime.withTaskLock(taskId, fn)`），避免 read-modify-write 与 run 回写交叉
- 业务行保存只更新显式字段（不要整行 upsert 覆盖并发 run 的 `last_*`/`run_count`）；run 结果用独立条件 UPDATE 回写

创建路径的 commit 上下文：

- 工具路径（`schedule_create`）优先使用 `api.commit(tx => tx.createTask(...))`；
- 管理台/对账路径使用 `harness.commit(tx => tx.createTask(...))`；
- 两条路径都只做一次 `tx.createTask`，owner conversation 已提前确保存在。

创建失败时：

- 业务行保留，`durable_task_id` 为空，`durable_state='failed'`
- 记录 `scheduler.durable_create_failed` 审计
- 启动对账/下次编辑会重试
- 管理台显示“未激活”徽标

#### 编辑

`schedule_update` / 管理台 POST 保存后：

- 若 `conversation_poisoned=1` / `durable_state='poisoned'`：除删除外，编辑/启用
  一律返回 409；必须先 `reset-conversation`
- 比较调度相关字段：`scheduleType/runAt/intervalSeconds/cronExpr/enabled/nextRunAt`
- 调度字段或 enabled 变化：
  1. 进入 per-task 锁（包的整个 read → version++ → save → cancel/abort → recreate）
  2. 在同一事务内 `schedule_version += 1` 并保存显式字段
  3. `SchedulerRuntime.cancelRun(taskId)`（内部完成两阶段：cancel chat +
     abortTask/waitForTask；编辑路径不再单独调用 abortTask）
  4. 只有 cancelRun 报告 `task terminal + chat 退出 + conversation idle` 后才清空
     `durable_task_id`
  5. `durable_state='pending'` → `ensureDurableTask`
- 只改 `name/prompt/notify*`：不重建，不递增 `schedule_version`（task phase 每次读最新业务行）
- 仅 Agent 变化：不重建（runner 每次按最新 `agent_id` 调用 chat）
- 旧 task 在 abort 前醒来时，会在 run phase 发现 `schedule_version` 不一致并 terminal `superseded`，不会执行新配置
- runner 在 reserve 后、提交 chat 前再次校验 `schedule_version`；不一致则不提交

#### 删除 / 禁用

**用户意图先落库，abort 后置处理**，避免 reconcile 复活已删除任务：

- `schedule_delete` / DELETE：
  1. per-task 锁
  2. **先**在同一事务内写 `deleted_at=now, enabled=0, durable_state='deleted'`
  3. `cancelRun`（内部 abortSession + abortTask + waitForChat/waitForTask + waitForIdle）；
     超时保留 `durable_state='aborting'`，但 `deleted_at` 已置位，reconcile 不会重建
  4. 清空 `durable_task_id`
  5. 后台 continuation（reconcile/周期扫描）在旧 task terminal 后清理 id
- `enabled=false`：同上，先写 `enabled=0, durable_state='disabled'`，再 cancel/abort；
  reconcile 以 `enabled=0` 为准，不会重建
- `enabled=true`：per-task 锁内 `schedule_version += 1`，`ensureDurableTask`
- Agent 删除：
  1. `SchedulerRuntime.abortForAgent(agentId)`：先批量标记该 Agent 所有
     `scheduled_tasks` 为 `deleted_at/enabled=0`，再逐个 `cancelRun + abort + wait`
  2. 执行 `deleteAgent` 软删除业务任务
  3. 启动/周期 reconcile 清理 `aborting`/孤儿 durable task（Agent 不存在/业务行 deleted）
  4. `abortForAgent` 可重试，且不依赖 `purgeAgent()` 的同步内存清理

#### once 任务

- 状态：`scheduled`（`next_run_at` 有值）→ `completed`（`next_run_at` 为空、`enabled=false`）
- 完成时：
  - ledger `status='done'`
  - `last_status='done'`
  - `durable_task_id` 保留但 task 已 terminal；`durable_state='done'`
  - finish 只在 `deleted_at IS NULL AND enabled=1 AND schedule_version=?` 时执行；
    若用户在 run 期间删除/禁用，以用户意图为准，finish 不覆盖
- reconcile：
  - `enabled=false && durable_state='done'` → 不 abort、不重建（幂等）
  - 编辑 once 任务（新的 `run_at`）→ `schedule_version += 1`，清理旧 task，重新创建
- 管理台显示“已完成”，而不是“未激活”
- once 执行失败：finish 写 `ledger=error`、`enabled=0`、`next_run_at=NULL`、
  `last_status='error'`、`durable_state='failed'`；durable task terminal（无下一次）。
  是否允许“重试失败 run”由管理台显式操作，不自动重排。
- once `failed` 与普通 `disabled` 区分：reconcile 不把 failed 当 disabled 重建；
  编辑 runAt（`schedule_version += 1`）或手动触发（`manual:<uuid>` runKey）才重新激活；
  管理台显示“失败（可编辑重试）”，不显示“重新启用”而自动重排。

#### 状态优先级（取消/删除 vs run 终态）

| 场景 | ledger 终态 | durable_state | 是否重建 |
|---|---|---|---|
| 用户删除期间 run 被中断 | `aborted` reason `deleted` | `deleted` | 否 |
| 用户禁用期间 run 被中断 | `aborted` reason `disabled` | `disabled` | 否 |
| once 执行失败 | `error` | `failed` | 否（手动重试） |
| chat 取消连续 5 次失败 | `failed` | `poisoned`（conversation_poisoned=1） | 否（需人工 reset） |
| crash-loop | 保持 running/attempt | `blocked` reason `restart_limit` | 仅 `retryTask` |
| 正常完成 | `ok` / once `done` | `active` / `done` | 下一次 wait |

规则：**用户意图（deleted/disabled）优先于 run 终态**；finish/cancel 不得把
deleted/disabled 改回 active/aborting。

#### 启动对账（reconcile）

`SchedulerManager.start()` 改为：

```ts
async start() {
  if (this.started) return;
  // 1. 注入 runner / owner conversation；acceptingRuns=false
  await SchedulerRuntime.init();
  // 2. 对账（创建/清理/接管 lease）
  await SchedulerRuntime.reconcile();
  // 3. 原子 markReady：acceptingRuns=true + scheduler ready=true
  SchedulerRuntime.markReady();
  this.started = true;
  logger.info("Scheduler", "Durable scheduler started");
}
```

`SchedulerRuntime.ready` 是唯一就绪状态；`acceptingRuns`、`/api/status`、drain 都读取
它，避免 gate 与 started 分离。start 失败回滚 ready=false。

启动顺序（`src/cli.ts`）：

1. `AgentManager.init()` **不再自动 `harness.resume()`**；改为 `init()` 只 open，
   或 `init({ resume: false })`
2. `await SchedulerManager.start()`（init + reconcile + gate）；**start 抛错则不得
   resume**，按启动失败处理（退出 78 或显式回退 polling）
3. `AgentManager.resume()`：此时 runner 已注入、owner conversation 已存在、gate 已开
4. 任何 due task 在 resume 后才可能进入 run phase

防御性 gate：`SchedulerRuntime.acceptingRuns=false` 时，run phase 调用 runner 会得到
`SchedulerNotReady`，phase 保留同一 checkpoint 并 1s 后重试，不会 fault 或提前 chat。

`reconcile()`：

1. 确保 scheduler-owner conversation 存在（`system_config`）
2. 遍历所有 `scheduled_tasks`（使用包含 deleted 的 raw store 方法，不能只查未删除行）
3. enabled && !deleted：
   - `conversation_poisoned=1` / `durable_state='poisoned'` → **不创建、不 retry、不清
     mapping**，只在管理台显示需要人工 reset
   - `durable_task_id` 缺失 / terminal / `missing_task` / `task_too_old` / `migration_failed` → 先清理旧 live task，再创建
   - `restart_limit` blocked → 保留
   - `aborting` → 等旧 task terminal；仍是 enabled 才创建
4. disabled 或 deleted：
   - 若 id 存在且 task 仍 live → cancel/abort；**绝不重建**
   - `done` 状态幂等跳过
   - `aborting` 继续等待并在 terminal 后清空 id
5. **接管 running run**：gateway.lock 保证单实例，reconcile 的顺序必须是
   标记旧 lease 失效 → `cancelRun(old)` → 等 `activeChats` 退出 → 递增
   `lease_fence` → 新 owner 执行；旧 runner 只有在确认失效后写 `aborted`，
   不得继续提交/写 outbox
6. 记录对账摘要审计：`scheduler.reconcile {created, aborted, blocked, failed}`
7. 对账本身在全局调度锁内执行，避免与 create/edit 并发
8. `reconcile` 失败：`start()` 抛错；**CLI 不得 resume**。durable 模式默认按启动
   失败处理：写入 `scheduler.start_failed` / `pending_start`，关闭 harness/storage
   （`AgentManager.shutdown()` 与 CLI cleanup 必须幂等：不重复 close、不触发
   drain），按配置错误退出（78）。此时 framework scheduler 尚未 resume，abort
   handler 不会执行，因此不做“abortAll 后继续运行”。
   回退 polling 只能在重启后以 `scheduler_durable_enabled=0` 启动，且启动时不安装
   scheduler task 定义；旧 durable task 成为 missing_task 不会执行。需要清理时在
   durable 模式下单独执行 `abortAll` 维护命令。

### 5.4 Wake / 定时器 / 时钟

- **不配置 `HarnessOptions.onWake`**：1.4.0 的语义是“提供 onWake 后 Harness 不再为
  sleep 安装内部 timer，宿主必须自己 arm wakeup 并调用 resume()”。本项目是长驻
  gateway，继续使用默认 `setTimer`（内部 `setTimeout`）自动唤醒 sleeping task。
- `GET /api/status` 按需调用 `harness.wake()` 读取 `{active, at}`，返回
  `scheduler.nextWakeAt`；这是只读观测，不改变唤醒机制。
- 如果未来要做进程休眠/Cloudflare 类宿主，再引入 `onWake`，并在回调里显式 arm
  宿主 timer + `resume()`；不能把 `onWake` 当作只读观测接口。
- `Harness.wake()`：启动/对账后记录一次，用于日志和状态
- 时钟：`runtime.now()` / `api.now()` 使用 Harness 时钟；业务库
  `saveScheduledTask/reserve/computeNextRunAt` 也必须注入同一个 clock（测试传入
  fake clock），避免 durable sleep 已到点而业务 next_run_at 未到点
- 长睡眠：保留单个 `sleepUntil`；1.4.0 nativeTimer 已处理 >2^31ms 的定时器分段，
  不需要按 30 天切分；只验收时钟回拨/前跳，每次唤醒后重新读取业务 `next_run_at`

### 5.5 Drain / 重启 / 崩溃

- `SchedulerManager.stop()`：设置 `started=false`，不再启动新的 run；sleeping 任务保持
- `inFlightCount`：仍统计正在执行的 run（drain 等待面）
- **durable busy 分类**：
  - `isDurableTaskPending` 排除 `kind === "bot.scheduled-prompt"`
  - 同时排除 `conversationId` 属于 `scheduled_tasks.conversation_id` 的所有任务
    （该 conversation 下的 `pi.generation` / `pi.tool` 也属于调度工作，不能全局阻塞 WS 队列）
  - `SchedulerRuntime.schedulerConversationIds()` 从业务库读取并缓存，create/edit/
    delete 时失效；重启后无需依赖内存 activeRuns
  - drain 的等待面 = `activeTurnCount` + 非调度 durable 任务 + `SchedulerManager.inFlightCount`
  - `SchedulerManager.isReady === false`（gate 关闭）时，drain 保守地把调度器计为
    pending，不能因 sleeping 形态提前退出
- 重启：
  1. `Harness.open` 加载 schema v2
  2. `SchedulerManager.start()` 注入 runner + reconcile
  3. `AgentManager.resume()` 恢复 sleeping 任务（runner/gate 已就绪）
- 崩溃恢复：
  - run checkpoint 已先落 durable；业务 reserve 用 `runKey` 幂等
  - `requestId` 去重提交；assistant entry 由 generation task 单次写入
  - 连续崩溃 5 次（`restartLimit`）→ 任务 parked，`/api/durable-tasks` 显示 blocked；仅 `restart_limit` 提供 retry
- 业务错误（模型 400/超时/Agent 删除）不 fault 任务：runner 捕获并记录，phase 继续 sleep 到下一次
- 取消/abort：
  - 不使用 framework `runtime.signal` 传播到 chat
  - 编辑/删除/禁用先 `SchedulerRuntime.cancelRun(taskId)`（内部两阶段：
    abortSession + abortTask → waitForChat/waitForTask/waitForIdle），不再单独调用
    abortTask
  - 超时保留 `aborting` 给 reconcile；业务行已先标记 deleted/disabled，不会被复活
  - drain 不主动取消已提交生成，仍由 50s 上限与重启恢复兜底

### 5.6 数据模型与迁移

业务库 migration v6（`src/database/migrations.ts` 追加）：

```sql
ALTER TABLE scheduled_tasks ADD COLUMN durable_task_id TEXT;
ALTER TABLE scheduled_tasks ADD COLUMN durable_state TEXT NOT NULL DEFAULT 'pending'
  CHECK (durable_state IN ('pending','active','aborting','blocked','disabled','done','deleted','failed','poisoned'));
ALTER TABLE scheduled_tasks ADD COLUMN schedule_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduled_tasks ADD COLUMN conversation_id TEXT;
ALTER TABLE scheduled_tasks ADD COLUMN conversation_poisoned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduled_tasks ADD COLUMN poison_run_key TEXT;
ALTER TABLE scheduled_tasks ADD COLUMN poison_fence INTEGER;

CREATE TABLE IF NOT EXISTS scheduled_task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_key TEXT NOT NULL,
  scheduled_for INTEGER NOT NULL,
  run_number INTEGER NOT NULL,
  schedule_version INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','ok','error','done','aborted')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  conversation_id TEXT,
  durable_task_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  lease_owner TEXT,
  lease_until INTEGER,
  lease_fence INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_task_runs_key
  ON scheduled_task_runs (task_id, run_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_task_runs_number
  ON scheduled_task_runs (task_id, run_number);
CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_task
  ON scheduled_task_runs (task_id, scheduled_for DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_lease
  ON scheduled_task_runs (status, lease_until);

CREATE TABLE IF NOT EXISTS scheduled_task_notifications (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload) AND length(CAST(payload AS BLOB)) <= 65536),
  status TEXT NOT NULL CHECK (status IN ('pending','sending','delivered','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error TEXT,
  claimed_by TEXT,
  claim_token TEXT,
  claimed_at INTEGER,
  claimed_until INTEGER,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_task_notifications_due
  ON scheduled_task_notifications (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_task_notifications_claim
  ON scheduled_task_notifications (status, claimed_until);
```

`ScheduledTaskDefinition` 增加：

- `durableTaskId?: string`
- `durableState: "pending" | "active" | "aborting" | "blocked" | "disabled" | "done" | "deleted" | "failed" | "poisoned"`
- `scheduleVersion: number`
- `conversationId?: string`（scheduler:<taskId> 的持久 conversation，首次 run 时写入）
- `conversationPoisoned?: boolean`（取消超时后置位，禁止自动复用）

字段语义：

- `schedule_version`：只在调度字段/enabled 变化时递增；name/prompt/notify 不变。runKey 与 run ledger 以它做代际校验。
- `durable_state`：SchedulerRuntime 持久化的生命周期状态；API 的“有效状态”= `durable_state` + `harness.inspect` 的 live 状态，避免状态源分裂。
- `conversation_id`：调度会话绑定；mapping 丢失时不得静默新建，否则 requestId 去重失效。
- `aborting`：旧 task 尚未 terminal；若业务行已 `deleted_at/enabled=0`，reconcile 只清理不重建。
- `poisoned`：连续 5 次无法确认 chat 退出。`conversation_poisoned=1` 时
  `durable_state` 固定为 `poisoned`（canonical），API/UI 一律显示 poisoned；
  `SchedulerRuntime.runScheduledPrompt` 入口直接抛 `ConversationPoisoned`；
  reconcile 不得创建/retry/清 mapping；只能走人工 reset。
- `poison_run_key` / `poison_fence`：poison 写入必须
  `UPDATE ... WHERE id=? AND schedule_version=? AND poison_run_key IS NULL`
  且携带当前 runKey/fence；旧 fence 不能 poison 新 owner。并发下由 reconcile 在
  全局调度锁补写。
- `run_key`：`schedule:<taskId>:<scheduleVersion>:<scheduledFor>` 或 `manual:<uuid>`。
- `request_id`：durable conversation 的提交去重键，等于 `sched:<taskId>:<run_key>`。
- `lease_owner/lease_until/lease_fence`：终态写入的独占权与 fencing token；只有 lease owner + 当前 fence 能把 `running` 改为终态；续租失败立即取消 runner。
- `scheduled_task_notifications`：通知 outbox；`runId` 唯一，`pending/failed(due)/sending(claim 过期)` 均可被原子 claim；`payload` 是发送所需内容的不可变 JSON 快照（taskName/status/result/error/source/scheduledFor/target）。
  - 写入前**先截断各字段**（result/error/taskName），再序列化；序列化后仍超过 64KB
    字节时写入最小合法 payload（runId/taskId/status/`truncated:true`），绝不让
    CHECK 失败导致 ledger/outbox 事务回滚
  - 不依赖 ledger 的 200 条保留策略

保留字段：

- `next_run_at` 仍是业务调度真相（编辑/手动触发/管理台都依赖）
- `last_run_at/last_status/last_result/run_count` 保留，兼容现有 UI；run ledger 为明细

迁移与回填：

- v6 迁移只增列/表；现有行 `durable_task_id=NULL`、`durable_state='pending'`、`schedule_version=0`
- 启动 reconcile 为 enabled 行创建 durable task 并写回 id
- 迁移本身不删除任何 `scheduled_tasks` 数据
- 回滚到旧版本时，新列/表可被忽略；durable task 需在回滚前 abort（见 §6.2）

保留策略：

- 每任务最多保留 200 条 run（插入时按 `task_id` 清理更旧记录）
- outbox `delivered` 保留 7 天，`failed` 保留 30 天
- `result` 沿用 `LAST_RESULT_MAX_CHARS` 截断

### 5.7 通知

- `scheduler.completed` 事件增加 `runId`、`source: "schedule" | "manual"`、`scheduledFor`
- run 终态提交时，在同一业务库事务内写 `scheduled_task_notifications`（`pending`，`runId` 唯一）；EventBus 的 `scheduler.completed` 只作为进程内唤醒信号，不作为唯一投递真相
- dispatcher 原子 claim（用 claim_token）：
  ```sql
  UPDATE scheduled_task_notifications
     SET status='sending', claimed_by=?, claim_token=?, claimed_at=?, claimed_until=?
   WHERE run_id=?
     AND ( (status='pending')
        OR (status='failed' AND next_attempt_at <= now)
        OR (status='sending' AND claimed_until < now) )
  ```
  `changes=1` 才发送；成功/失败回写也必须带
  `WHERE status='sending' AND claim_token=?`，防止旧 sender 覆盖新 claim
  - 成功：`delivered + delivered_at`（`WHERE status='sending' AND claim_token=?`）
  - 失败：`failed + attempts = attempts + 1 + next_attempt_at`（同一条件；指数退避，上限 1h）
  - `sending` 的 `claimed_until` 过期后允许重新 claim；attempts 单调递增
- 启动时和 30s 周期扫描 due outbox（不依赖 EventBus 事件是否送达），保证“事务已写 outbox、唤醒事件丢失”也能补发
- 管理台可对 `failed` 手动重试（重置 next_attempt_at/attempts，claim_token 重新生成）
- `NotificationDispatcher` 仍按“任务通知目标 → Agent 绑定渠道兜底”寻址
- 进程内 LRU 只作为快速路径，不作为唯一去重
- 手动触发复用同一 outbox 形状，`source:"manual"`
- 离线/跨渠道重试仍为 backlog，本期只保证单进程内的 outbox 可靠投递

### 5.8 API 与管理台

新增/调整：

- `GET /api/scheduled-tasks`
  - 返回 `durableTaskId`（numeric `TaskId` → string）、`durableState`、`scheduleVersion`、`conversationId`
  - `durableState` 是 SchedulerRuntime 持久化的声明状态；另返回 `liveState`（`harness.inspect` 的 sleeping/blocked/running/terminal）
  - 组合规则：`blocked`/`aborting` 优先于 `active`；inspect 已 terminal 且声明为
    `done/disabled/deleted` 时显示对应终态；只有 `blocked.reason === "restart_limit"`
    允许 retry
- `GET /api/scheduled-tasks/:id/runs?limit=&offset=`
  - run ledger 分页（status/result/error/attempt/lease/fence）
- `POST /api/scheduled-tasks/trigger`
  - **先** `assertConversationUsable(taskId)`：检查 task 存在/deleted/enabled →
    poisoned → conversation/mapping；poisoned 返回 409 / `ConversationPoisoned`，
    不写 ledger、不增加 runCount
  - 走同一 `reserveScheduledRun` 事务（`runKey=manual:<uuid>`、`advanceSchedule=false`），分配 runNumber/lease，调用同一 runner；不推进 `next_run_at`
  - 定时、手动、retry 三个入口统一经过该检查
- `POST /api/scheduled-tasks`
  - 所有写路径先走 store transaction（显式字段 + `schedule_version`），再进入
    runtime per-task lock；API 不得直接整行 `saveScheduledTask` 覆盖
  - 保存后调用 `SchedulerRuntime.reactivate(taskId)`（仅在调度字段/enabled 变化时）
  - 若旧 task 正在 abort：返回 `202 { status: "aborting" }`，前端轮询/刷新状态
- `DELETE /api/scheduled-tasks`
  - 进入 per-task 锁，abort + wait；超时返回 `202 { status: "aborting" }`，不返回“已删除但旧 task 仍活着”
- `POST /api/scheduled-tasks/:id/reset-conversation`
  - 仅用于 `durable_state='poisoned'`
  - 顺序：
    1. `cancelRun` 到四项门槛；若无法达成，显式关闭该 conversation 的 harness
       通道/丢弃旧 conversation（写审计）
    2. 在同一业务事务内：清 `conversation_poisoned`、`schedule_version += 1`、
       写新 `channel_sessions` mapping + 新 `conversation_id`
    3. 清理 AgentManager 内存：`conversations`、`busyTurns`、`activeChats`、
       `conversationToAgent` 中该 scheduler key 的旧项；新 chat 入口按
       `conversation_id` exact match，拒绝旧缓存
    4. 再 `ensureDurableTask`
  - 旧 conversation 不得再被任何 task 引用；reset 写审计 `scheduler.conversation_reset`
  - 该操作必须持有 per-task 锁，禁止与编辑/触发并发
- `POST /api/durable-tasks/retry`
  - 仅对 `blocked.reason === "restart_limit"` 返回 200；其他 blocked reason 返回 409，并在管理台隐藏“重试”
- `GET /api/status`
  - `scheduler: { mode: "durable", started, inFlight, nextWakeAt, tasksActive, tasksBlocked }`

管理台 `ScheduledTasksView`：

- 任务卡片增加：
  - “Durable: sleeping until / blocked (reason) / aborting / 未激活 / done”徽标
  - 最近一次 run 的状态/耗时/错误摘要
- 新增“运行历史”抽屉/弹层：分页展示 run ledger
- blocked durable task：仅 `restart_limit` 显示“重试任务”，调用 `/api/durable-tasks/retry`；其他 reason 显示诊断
- `aborting` 状态显示“正在停止旧任务”，禁用编辑/删除按钮直到变为 active/disabled
- 保持现有创建/编辑/手动触发/删除交互

### 5.9 安全

- durable task input 只存 `scheduledTaskId`，不存 prompt/凭据；每次 phase 从业务库读取，天然跟随软删除/禁用
- `run` 前重新校验：
  - task 存在、未删除、enabled
  - Agent 存在（否则记录 error 并继续下一次，不进入 chat）
- `AgentManager.chat` 仍走原有会话串行锁、沙盒与归属解析
- 调度会话绑定 `scheduled_tasks.conversation_id`；mapping 丢失时 fail-closed（记录
  error/要求修复），不静默新建，避免 requestId 去重失效导致重复回答
- 管理台 API 仍受 `x-bot-token` 保护；手动触发/重试写审计
- run ledger 的 result/error 截断；不新增敏感字段
- durable task owner conversation 为 ownerless、background，不进入用户会话列表

## 6. 兼容与灰度

### 6.1 功能开关

`system_config.scheduler_durable_enabled`：

- `1`：durable scheduler（默认，通过测试后）
- `0`：保留现有 1s 轮询（回滚路径）

启动时（**模式在启动时决定，不支持进程内切换**）：

- 开关为 1：安装 `system-scheduler` 扩展，`SchedulerRuntime.init/reconcile` →
  `markReady` → `AgentManager.resume()`
- 开关为 0：**不安装** `system-scheduler` 扩展，不创建 durable task；启动 1s 轮询。
  storage 中遗留的 `bot.scheduled-prompt` 任务因 definition 缺失成为
  `missing_task` blocked，不会执行；需在 durable 模式下运行一次
  `SchedulerRuntime.abortAll()` 清理，再以 polling 模式启动
- 1.4.0 Harness **没有 pause/stop scheduler API**；不能在同一进程内“临时 resume
  abortAll 再 stop”。切换模式必须：停 gateway → （可选）durable 模式清理 →
  以目标模式重启
- 双跑保护：任何时刻只允许一种模式；polling 模式不得安装 scheduler task 定义，
  也不得创建新的 durable task

### 6.2 迁移

- 业务库 v6 迁移自动执行；`durable_task_id` 为空由 reconcile 补齐
- 会话库 schema v2 是 1.4.0 前置条件；升级前备份 `conversations.sqlite`
- 回滚：
  - 业务库 v6 只增列/表，可被旧版本忽略
  - 会话库 schema v2 **不可回退**；回滚到 1.3.0 需要恢复备份
  - durable scheduler 回滚到 polling：关闭开关、重启；reconcile 会 abort 所有调度 durable task

## 7. 测试计划

### 单元

- `reserveRun` 幂等：同一 `(taskId, runKey)` 只生成一条 ledger、只递增一次 runCount
- `reserveRun` 代际：`scheduleVersion` 不匹配返回 `superseded`，不写 ledger
- lease：两个 owner 竞争同一 running run，只有一个能写终态；过期 lease 可接管
- `computeNextRunAt` 回归（once/every/cron）
- `ScheduledPromptTask` phase（fake `now`/`setTimer`）：
  - wait → sleeping → run → wait
  - disabled/deleted/once done → terminal
  - name/prompt 编辑后 runKey 不变
  - scheduleVersion 变化后旧 task → `superseded`
  - run checkpoint 在业务 reserve 前已持久化
- 任务编辑判定：只改 name/prompt 不重建；改 schedule/enabled 递增 version 并重建
- `isDurableTaskPending` 排除 `bot.scheduled-prompt`（running/ready 不阻塞 WS 队列）
- 通知 outbox：`pending → sending → delivered`；重复 claim 只成功一次；失败退避

### 集成 / 故障注入

- 创建任务：工具/API → durable_task_id 存在 → `GET /api/durable-tasks` 可见
- 到点触发：假时钟推进 → chat runner 被调用一次；重复 resume 不重复提交
- 重启：创建未来任务 → close/reopen Harness（真实 SQLite open/close/reopen）→ 到点仍触发
- **answer settled 后、ledger 终态前崩溃**：重放不重复 assistant entry，ledger 最终 done
- **run checkpoint 已写、业务 reserve 前崩溃**：恢复后按 checkpoint 的 runKey 补建 ledger
- **业务 reserve 已写、chat 提交前崩溃**：重放同 requestId，只产生一次回答
- **abort mark 后、abort handler 前重启**：旧 task 最终 terminal，新 task 不并发创建
- **编辑与唤醒并发**：旧 task 读到新 scheduleVersion → superseded；新 task 只触发新配置
- **两个任务同一时刻触发**：ledger 各自独立，不阻塞彼此
- **通知写入与发送之间崩溃**：outbox 恢复后补发一次，不重复
- **系统时钟回拨/前跳**：唤醒后重新读取 `next_run_at`，不早触发/不漏触发
- **WS 队列在调度 run 运行时仍可投递**：durable busy 不计 `bot.scheduled-prompt`
- **abort 中断 chat**：编辑/删除时 `cancelRun` 调用 `abortSession`，phase 在模型完成前退出并写 `aborted`
- **pi.generation 不阻塞队列**：调度 run 期间 scheduler conversation 下的 generation/tool
  任务不被计入 `durableBusyCount`；普通 WS 队列仍可投递
- **启动 gate**：runner/gate 就绪前 resume，due task 不能进入 chat；gate 开启后正常触发
- **onWake 不使用**：不配置 onWake，sleeping task 仍由默认 timer 唤醒；`wake()` 只读
- **删除超时不被复活**：deleted 先落库，abort 超时后 reconcile 只清理不重建
- **once done**：reserve 置空 next_run_at，run 成功后才 enabled=false；终态 done 不是 disabled
- **outbox failed 重试**：failed 到期后可重新 claim；sending 过期可接管；启动扫描补发
- **lease fence**：旧 owner 续租/终态写失败后不能继续提交/通知
- **手动触发**：走同一 reserve/lease/ledger/outbox，runNumber 不重复
- **conversation 映射丢失**：fail-closed，不在新 conversation 重新回答
- **统一 clock**：业务 next_run_at 与 durable sleep 使用同一 fake clock
- **activeChats 注册前取消**：chat 已注册但尚未进入 busyTurns，cancel 仍能生效
- **旧 submission placed 后取消**：waitForChat 成功后 submission 被 abort/clear，不挂到新 run
- **cancelRun 重入**：外部 cancel 与 phase catch 并发调用，幂等、无自等待/死锁
- **poisoned 端到端**：5 次取消后新 chat 被 `ConversationPoisoned` 拒绝；reconcile
  不重建/不 retry；人工 reset 后才恢复
- **ConversationPoisoned 不可重试**：poisoned 任务不进入 cancelChat/30s sleep，
  直接 terminal + 审计
- **成功 cancel 清 attempts**：4 次失败 → 成功 → 再 1 次失败不 poison
- **polling fallback 无 pause API**：验证不使用不存在的 stop/resume=false；
  模式切换只在重启时发生
- **旧 fence 的 cancelAttempts 不能 poison 新 fence**：接管后 cancelFence 变化，
  attempts 从 0 计数；旧 fence 的 poison/终态写入被拒绝
- **reset-conversation 与旧 chat 并发**：旧 chat 仍在写时 reset 必须先 cancel 到
  门槛，新 mapping 生效后旧 conversation 不再被引用
- **placed submission.abort = already_placed**：不误判为清理成功，继续
  conv.abort + waitForIdle；未 idle 不重建
- **删除后 finishRun 不复活**：run 期间删除，finish 只写 ledger/outbox，不写回 scheduled_tasks
- **start 失败不 resume**：reconcile/start 抛错时 CLI 不 resume，进程按配置错误退出或回退 polling
- **Agent 删除时 abort 失败**：持久化 `aborting`，reconcile 清理孤儿 task，不复活
- crash-loop：模拟 run phase 崩溃 5 次 → blocked → `retryTask` 可恢复
- drain：sleeping 任务不阻塞；in-flight run 被等待；50s 上限后 exit 75
- 真实 Harness 重入：在 `run` phase 内调用 `AgentManager.chat`，验证无死锁/无 phase-end 误取消

### 真实 provider 冒烟

- `runAt = now + 5s` 创建任务，等待触发，验证回答/通知/ledger
- 触发前重启 gateway，验证恢复后仍触发
- 手动触发与定时触发并发，验证 ledger 去重与 runCount
- 编辑任务到更早时间，验证旧 task abort + 新 task 精确触发

## 8. 风险与开放问题

| 风险 | 说明 | 缓解 |
|---|---|---|
| 双库一致性 | 业务 reserve 与 durable checkpoint 不能同一事务 | checkpoint 先落 runKey；ledger 唯一键 + lease + requestId；接受 at-least-once |
| 任务 phase 内调用 `AgentManager.chat` | 同一 Harness 重入，可能死锁/长持有 invocation | scheduler 专用 conversation；不传 framework signal；真实 harness 重入测试；失败则切 A′ |
| 编辑/abort 竞态 | abort 是异步的，旧任务可能刚醒 | per-task 锁 + `aborting` + `waitForTask`；schedule_version 让旧 task terminal |
| 通知重复/漏发 | 崩溃点位于 ledger 终态与发送之间 | outbox pending/sending/delivered/failed + 原子 claim + 重试 |
| 长睡眠与时钟回拨 | `setTimeout` 对系统时钟变化的语义 | 使用 Harness 时钟；唤醒后重新读取 `next_run_at`；不切分长睡眠（1.4 nativeTimer 已处理 >2^31ms） |
| 任务数量增长 | 每任务一个 durable task | 现有 API 无上限；建议 1000 个/实例上限 + 管理台告警 |
| 1.4 schema v2 | 不可回退 | 升级前备份；版本说明 |
| 关掉功能开关时已有 sleeping task | 可能双跑 | 切换时 reconcile abort 所有调度任务；开关变更需重启 |

开放问题：

1. `run` phase 直接调用 `AgentManager.chat` 还是改为“入队 + 宿主 worker”？建议先用直接调用做原型（不传 framework signal），真实 harness 压测后再定。
2. once 任务完成后业务行保留（当前语义）还是自动软删除？建议保留，durable task terminal。
3. 通知已经改为 outbox；跨渠道离线队列仍为 backlog，本期不做。
4. 是否给 run ledger 增加 token/cost 统计？可从 `AgentManager.getUsageStats` 取增量，后续可选。
5. 管理台是否要“立即执行”与“重试上一次失败 run”两个动作？建议保留现有手动触发；失败 run 重试作为 6.x。

### 建议决策（待用户确认）

- **保留方案 B（每任务一 durable task）**：精确唤醒和任务级隔离是核心收益；A′ 的 coordinator+worker 作为退路，只有在真实 harness 重入测试失败时才切换。
- **run phase 先直接调用 `AgentManager.chat`，但不传 framework `runtime.signal`**：避免 phase-end abort 误取消；取消由宿主显式 abort/drain 处理。
- **once 完成后保留业务行**，durable task terminal；管理台显示 done，编辑后可重建。
- **通知使用 outbox**：pending/sending/delivered/failed + runId 唯一；进程内 LRU 只做快速路径。
- **run ledger 首期不记 token/cost**；后续可从 usage 增量补充。
- **手动触发与定时触发共用 runner**，只是 runKey 前缀不同（`manual:` / `schedule:`）。

### Codex R1 评审修订记录

| 编号 | 修订 |
|---|---|
| B1 runKey 含 updatedAt | runKey 改为 `taskId + scheduleVersion + scheduledFor`；name/prompt 编辑不改变身份 |
| B2 requestId 不覆盖 answer entry | 明确 assistant entry 由 generation task 单次写入，chatTurn 只 `tx.entry` 读取；新增故障注入测试 |
| B3 runtime.signal 误取消 | runner 不再接收 framework signal；drain/取消走宿主显式路径 |
| B4 abortTask 非同步终态 | 增加 `aborting` 状态、`waitForTask`、per-task 串行锁；超时留给 reconcile |
| B5 双库半提交 | wait phase 先持久化 run checkpoint，再进入 run/reserve；ledger 用 checkpoint 的 runKey 补建 |
| B6 durable busy 阻塞队列 | `isDurableTaskPending` 排除 `bot.scheduled-prompt`；drain 使用 `SchedulerManager.inFlightCount` |
| M7-M12 | ledger lease/attempt/request_id、per-task 锁 + schedule_version、once 状态、Agent 删除顺序、通知 outbox、取消 30 天切分 |
| MINOR | blocked reason 区分、迁移约束/索引、API 202/409、故障注入矩阵、方案 A′ 对比 |

### Codex R2 评审修订记录

| 编号 | 修订 |
|---|---|
| R2-B1 abort 无法中断 chat | 增加 `activeRuns` 注册表 + `cancelRun`：abortSession → 等 chat 退出 → abortTask/waitForTask |
| R2-B2 pi.generation 仍阻塞队列 | durable busy 同时排除 `scheduled_tasks.conversation_id` 下的所有任务 |
| R2-B3 启动顺序 | `AgentManager.init` 不自动 resume；SchedulerManager.start 完成后才 resume；增加 acceptingRuns gate |
| R2-B4 onWake 导致不唤醒 | 不配置 onWake；继续默认 setTimer；status 按需调用 wake() |
| R2-B5 删除复活/缺 deleted | 先落 deleted/enabled=0 再 abort；durable_state 增加 deleted；aborting 后台 continuation |
| R2-B6 once 误判 disabled | run 先判 next_run_at 为空→done，再判 disabled；finishRun 才置 enabled=false |
| R2-M7 异常 ledger 悬挂 | RunnerFinalizeError 保留同一 checkpoint 30s 重试；catch 写 error/aborted |
| R2-M8 version 锁顺序 | per-task 锁包住 version++/save/cancel/abort/recreate；chat 前二次校验 |
| R2-M9 outbox failed 不重试 | claim 条件覆盖 pending/到期 failed/过期 sending；启动+30s 扫描 |
| R2-M10 lease 无 fencing | ledger 增加 lease_fence；续租/终态/outbox 均带 fence |
| R2-M11 手动触发未统一 | 手动触发也走 reserve/lease/ledger/outbox，`advanceSchedule=false` |
| R2-M12 durable_state 状态源 | 声明状态 + liveState 组合；SchedulerRuntime 统一更新 |
| R2-M13 conversation 丢失重复回答 | 持久化 conversation_id；mapping 丢失 fail-closed，不新建 |
| R2-MINOR | start 成功后才 started、raw store 含 deleted、deleted CHECK/索引、统一 clock、补充验收 |

### Codex R3 评审修订记录

| 编号 | 修订 |
|---|---|
| R3-B1 cancelRun 无完成信号 | AgentManager 增加 `activeChats` 完成 promise + `waitForChat`；abortSession 返回值不再当作完成；超时保留 aborting |
| R3-B2 异常重试留旧 chat | catch 先 cancelRun + waitForChat；超时 commit terminal failed（chat_cancel_timeout），不重试同一 checkpoint |
| R3-B3 start 失败行为 | 规定 start 抛错时 CLI 不得 resume；durable 模式启动失败按 78/回退 polling |
| R3-B4 finish 复活删除行 | finish 只更新 `deleted_at IS NULL AND schedule_version=?`；once done 需 `enabled=1`；绝不写 deleted_at/enabled=1 |
| R3-M5 conversation 归属 | 首次 run 持久化 mapping + conversation_id；校验 agent_id 一致；丢失 fail-closed |
| R3-M6 fence 语义 | fence 只在接管时递增；续租只校验 fence；终态/outbox 使用同一 fence |
| R3-M7 接管顺序 | 标记旧 lease 失效 → cancelRun → wait activeChats → 递增 fence → 新 owner |
| R3-M8 outbox payload | outbox 增加不可变 payload 快照；claim_token 回写校验；失败可重 claim |
| R3-M9 once/删除优先级 | finish 条件含 deleted_at/enabled/schedule_version；用户删除/禁用优先 |
| R3-M10 gate/drain | start 成功后才 resume；isReady=false 时 drain 保守计入 pending |
| R3-M11 conversationId 边界 | numeric ConversationId ↔ TEXT 明确；首次成功后持久化；之后 exact match |
| R3-MINOR | liveState/durableState 组合规则、outbox 索引/保留、原子 ready 状态、补充验收 |

### Codex R4 评审修订记录

| 编号 | 修订 |
|---|---|
| R4-B1 cancelRun 自等待 | 两阶段：外部 cancelRun 先 abortSession+abortTask（不等）→ Promise.all(waitForChat,waitForTask)；phase catch 只 cancelChat，不 abortTask |
| R4-B2 注册前取消无效 | activeChats 进入即注册 AbortController；cancelChat 按 taskId 查 activeChats，不依赖 busyTurns |
| R4-B3 超时孤儿 chat | 超时不直接 terminal；更新 checkpoint cancelAttempts，30s 重试；5 次后才 terminal failed + conversation poisoned |
| R4-M4 activeChats key | key 用稳定 taskId，记录实际 agentId/sessionId；按 taskId 取消 |
| R4-M5 submission 残留 | waitForChat 后 conv.waitForIdle + submission.abort/clear；未 idle 不重试 |
| R4-M6 删除/terminal 竞争 | 增加状态优先级表：deleted/disabled 优先；ledger/durable_state 不互相覆盖 |
| R4-M7 start 失败副作用 | pending_start/start_failed + abortAll + 清理 owner/active 后才回退 polling |
| R4-M8 outbox 回写 | 成功/失败回写均带 status='sending' AND claim_token；attempts 单调 |
| R4-M9 旧 owner 写终态 | 新 fence owner 写主 status/outbox；旧 owner 只写 attempt/audit；无新 owner 时 reconcile 写 aborted |
| R4-M10 conversation_id 原子性 | mapping 存在/任务为空时 backfill；one-task-one-conversation 唯一约束；不一致 fail-closed |
| R4-MINOR | once failed 与 disabled 区分、API 写事务、payload JSON/64KB、activeChats/submission/cancelRun 验收 |

### Codex R5 评审修订记录

| 编号 | 修订 |
|---|---|
| R5-B1 placed submission 不可 abort | 明确 submission.abort 只对 queued；placed 走 conv.abort({background:true}) + waitForIdle；四项条件满足才重建 |
| R5-B2 poisoned 未接入 chat | runner 入口检查 conversation_poisoned；getOrCreateConversation 不得自动重建；新增 reset-conversation API |
| R5-B3 poisoned 后 reconcile 重建 | reconcile 对 poisoned 不创建/不 retry/不清 mapping；仅人工 reset |
| R5-M4 重建门槛 | 明确 waitForTask terminal + waitForChat resolved + waitForIdle + submission 非 placed/queued |
| R5-M5 cancelAttempts 与 fence | cancelAttempts 按 (runKey, lease_fence) 计数；接管后重置 |
| R5-M6 start 失败 abortAll | durable 启动失败默认关闭 harness/exit 78；fallback polling 才临时 resume 执行 abortAll |
| R5-M7 mapping 缺失重建 | 调度路径用 openSchedulerConversation/harness.conversation；undefined fail-closed |
| R5-M8 payload JSON | CHECK json_valid(payload) AND length<=65536；写入端校验/截断 |
| R5-MINOR | submissionId 回填、cancelRun 统一两阶段、once failed UI/retry、poisoned 验收 |

### Codex R6 评审修订记录

| 编号 | 修订 |
|---|---|
| R6-B1 cancelFence 未落地 | catch 读取 currentRunFence；`cp.cancelFence !== fence` 时 attempts 从 0；poison 写入带 fence 条件 |
| R6-B2 重建门槛顺序 | 外部 cancelRun：先 cancelChat + abortTask，再 Promise.all，再 inspect + waitForIdle；无 generation/placed/queued 才重建 |
| R6-M3 手动触发 poison | 所有触发入口先 `assertConversationUsable(taskId)`；poisoned → 409，不写 ledger |
| R6-M4 reset 原子性 | reset 先 cancel 到门槛；同一事务清 poison/version++/新 mapping；per-task 锁 |
| R6-M5 poisoned canonical | `conversation_poisoned=1` 固定映射 `durable_state='poisoned'`；UI/API 唯一 |
| R6-M6 polling fallback 双跑 | 必须等所有调度 task terminal 才启动 polling；aborting 时跳过并继续清理 |
| R6-M7 payload 字节 | `length(CAST(payload AS BLOB)) <= 65536`；写入端按 UTF-8 字节截断 |
| R6-MINOR | conv 不存在只清 controller/queued、queued/placed 动作区分、旧 fence/reset 并发验收 |

### Codex R7 评审修订记录

| 编号 | 修订 |
|---|---|
| R7-B1 ConversationPoisoned 误重试 | catch 首部特判：不 cancelChat、不累计 attempts，直接 terminal failed + 审计 |
| R7-B2 成功 cancel 未清计数 | 成功取消后 checkpoint 写 `{cancelFence: fence, cancelAttempts: 0}`；失败才累加 |
| R7-B3 fallback 无 pause API | 模式只在启动时决定；polling 不安装 scheduler task 定义；切换需重启/维护命令，不假设 stop/resume=false |
| R7-M4 inspect 谓词 | 同 conversation 无 pi.generation/pi.tool 的非 terminal 状态；terminal 可接受 |
| R7-M5 currentRunFence 来源 | 按 (task_id, run_key) 读 running 行；不存在/非 running 抛 LeaseLost/RunFinalizeError |
| R7-M6 poison 原子性 | 增加 poison_run_key/poison_fence；UPDATE 带 runKey/fence 条件；并发由 reconcile 全局锁补写 |
| R7-M7 reset 内存缓存 | reset 清 conversations/busyTurns/activeChats/conversationToAgent；新 chat exact match 拒绝旧缓存 |
| R7-M8 payload 截断 | 先截断字段再序列化；仍超限写最小合法 payload，不让 CHECK 回滚事务 |
| R7-MINOR | assertConversationUsable 顺序、start cleanup 幂等、poisoned/成功 cancel/polling 验收 |

## 9. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 | 数据模型 v6 + run ledger + store 方法 | 迁移/单测 |
| M1 | `ScheduledPromptTask` + `SchedulerRuntime`（ensure/abort/reconcile） | 任务创建/对账单测 |
| M2 | runner 幂等（requestId + ledger）+ chat requestId 支持 | 重放/并发单测 |
| M3 | 工具/API/管理台接入 + 编辑/删除/禁用 | 集成测试 |
| M4 | drain/restart/crash-loop + 真实 provider 冒烟 | 端到端验收 |
| M5 | 默认启用 durable，保留 polling 开关 | 灰度一周 |
| M6 | 移除 polling 代码与旧探针 | 清理 |

## 10. 与 1.4.0 其他能力的边界

本期只使用 1.4.0 的：

- durable sleeps / `setTimer` / `wake`（仅只读观测；不配置 `onWake`）
- crash-loop guard / `restartLimit` / `retryTask` / `TaskInspection`
- `models`/`settings` 函数、`onReport`（已在 1.4.0 升级中接入）

不在本期：

- Telemetry spans/metrics（`HarnessOptions.telemetry`、`AI_TELEMETRY_SCHEMA`）
- deferred tools / `tool_search` / codemode（Agent 能力主题）
- `read` 图片与 Photon 图像处理
- `afterFailedRun`（WS 队列在 gateway 层，durable inbox 不参与）

这些可作为六期之后的独立小版本评估。

## 11. Codex 对抗评审记录

评审方式：herdr 同 tab Codex，直接读取设计稿与 1.4.0 源码/类型，只输出评审结论。

| 轮次 | 结论 | 主要遗留 |
|---|---|---|
| R1 | 6 BLOCKING | runKey 身份、answer entry、runtime.signal、abortTask 终态、双库半提交、durable busy |
| R2 | 6 BLOCKING | abort 无法中断 chat、pi.generation 饥饿、启动顺序、onWake、删除复活、once disabled |
| R3 | 4 BLOCKING | cancel 完成信号、异常旧 chat、start 失败、finish 复活 |
| R4 | 3 BLOCKING | cancelRun 自等待、注册前取消、超时孤儿 chat |
| R5 | 3 BLOCKING | placed submission、poisoned 未接入、poisoned reconcile |
| R6 | 2 BLOCKING | cancelFence 未使用、重建门槛顺序 |
| R7 | 3 BLOCKING | ConversationPoisoned 误重试、成功 cancel 未清计数、fallback 无 pause API |
| **R8** | **NO BLOCKING ISSUES** | 设计可作为 M1/M2 实现基线 |

### R8 非阻塞建议（实现期落成代码契约）

1. `ConversationPoisoned` 分支同时原子写 canonical `conversation_poisoned=1` /
   `poison_run_key` / `poison_fence` / `durable_state='poisoned'`；terminal outcome
   只作为 framework receipt。
2. 成功 cancel 清零前重新读取 `(task_id, run_key)` 的当前 fence；只有仍匹配才
   commit，避免把旧 checkpoint 写回新 run。
3. polling 模式启动时显式排除 `bot.scheduled-prompt` 的 `missing_task` blocked 任务
   于 drain/busy 统计，或启动清理为 orphaned/terminal。
4. reset-conversation 增加 `retired_conversation_ids`（或 retired 标记），所有
   `openSchedulerConversation` 拒绝 retired id；旧 chat 未 idle 时强制关闭。
5. outbox payload 增加 `version` / `truncated` 字段；最小 payload 至少保留 `target`
   或明确 fallback 到 Agent 绑定渠道。
6. `currentRunFence` 抛 `LeaseLost`/`RunFinalizeError` 时明确 terminal/ledger 规则。
7. `cancelChat` 返回 `{ chatExited, idle, reason }`，调用方逐项检查，不用单一 boolean。
8. `markConversationPoisoned` 的 UPDATE 条件补 `current_run_key` / `current_lease_fence`。
9. 测试补“canonical poisoned 不被 terminal failed 覆盖”和“polling missing_task 不计 drain”。

## 12. 实现期 Codex 对抗评审记录（2026-10-25）

评审方式：herdr 同 tab Codex 直接读取工作区代码与 `git diff`，只输出 BLOCKING；
每轮修复后重新评审，直到无阻碍性问题。

| 轮次 | 结论 | 主要修复 |
|---|---|---|
| R1 | 2 BLOCKING | 同 owner 重放被误判 takeover；conversation 缺失被当作 idle |
| R2 | 4 BLOCKING | 兜底 abort 绕过 fail-closed；manual/scheduled 并发；同 owner lease 接管；manual 启动异常无终态 |
| R3 | 2 BLOCKING | 异常时无条件释放 lease；manual 与 finally 竞态 |
| R4 | 3 BLOCKING | 删除/行消失遗留 running ledger；busy 永久让路；manual 失败 lease |
| R5 | 3 BLOCKING | reap 误杀刚 reserve 的 run；orphan 收尾不可见 |
| R6 | 4 BLOCKING | starting 全局跳过导致饿死；forceAbort 覆盖用户禁用；reap 未取消 chat |
| R7 | 2 BLOCKING | starting 时间边界；cancel 期间 run 被新 owner 接管 |
| R8 | 2 BLOCKING | starting Set 无计数；attemptCount 误当 cancel 失败计数 |
| R9 | 2 BLOCKING | v6 旧库不补列；renew 无法区分正常 run 与 reap claim |
| R10 | 4 BLOCKING | reap claim 无独立驱动；内存 claim 重启丢失；claim 无上界；task 级取消误伤 |
| R11–R18 | 逐步收敛 | 中途引入过持久 reap claim/reaper，R19 起整体移除、回到“启动 reconcile 恢复”基线；保留 runKey+owner+fence 绑定取消、no-entry fail-closed、poison 边界 |
| **R19** | 3 BLOCKING | reconcile 接管不可重放 run；reconcile 失败无重试；取消未全部绑定身份 |
| **R20** | 1 BLOCKING | 崩溃恢复时旧 generation 无 active entry，reconcile 无法收敛 |
| **R21** | **NO BLOCKING ISSUES** | 启动 reconcile 受控 conversation abort + 条件接管；继续以 R21 为实现基线 |

### 最终实现契约（R21）

- 运行期**不再有 orphan reaper**：崩溃/遗留 running ledger 只由启动 reconcile 处理；
  reconcile 不能收敛时拒绝 `markReady`（CLI 不 resume）。
- reconcile 只接管可重放 run：`task` 未删/启用/未 poison、live durable task 存在、
  `run.durableTaskId === task.durableTaskId`、`run.scheduleVersion === task.scheduleVersion`。
- 不可重放 run 先按 `(runKey, owner, fence)` 取消 chat；确认 idle 后条件 forceAbort
  ledger。旧 owner 的 recovered generation 允许一次受控 conversation abort（仅当该
  task 全部 running run 都属于旧 owner）。
- 取消入口全部 run-scoped：`runKey + expectedOwner + expectedLeaseFence`；不存在
  taskId 级 conversation 兜底；phase catch 也绑定当前 fence。
- 单任务同一时刻只允许一个 running run（reserve 事务内 busy 仲裁）。
- 测试基线：216 tests / 16 suites；typecheck 通过；真实 provider 冒烟覆盖到点触发、
  手动触发、删除 sleeping task、关闭 Harness 后重启恢复。
