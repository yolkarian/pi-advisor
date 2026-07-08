# Pi Coding Agent Advisor Extension 实现计划

## 0. 背景与目标

本文档描述如何为 **Pi Coding Agent** 实现一个基于 *advisor strategy* 的 extension。

核心思想：

> 主 loop 使用低成本、低延迟的 executor 模型；当 executor 遇到关键架构决策、重复失败、复杂修改前后验证等高价值节点时，通过 tool call 向一个更强的 advisor 模型咨询。advisor 不直接改文件、不执行命令、不面向用户输出，只返回简短、结构化、可执行的建议。

对应架构：

```text
User
  ↓
Pi 主 agent loop：cheap executor model
  ↓
read / grep / bash / edit / write / test
  ↓
advisor() tool call
  ↓
Pi extension 收集当前 session context
  ↓
调用 high-end advisor model
  ↓
advisor 返回 plan / correction / stop signal
  ↓
executor 继续执行主 loop
```

目标不是让强模型参与所有步骤，而是让便宜模型在关键分叉点获得高质量战略校正。

---

## 1. 产品定义

实现一个 Pi extension，提供：

```text
/advisor status
/advisor on [provider/model]
/advisor off
/advisor config
/advisor config key=value
/advisor ask
```

以及一个 LLM 可调用工具：

```text
advisor()
```

建议 MVP 阶段将 `advisor()` 设计为 **zero-parameter tool**。

原因：

1. 低等级 executor 模型可能会错误描述问题。
2. extension 可以自动从 Pi session、tool activity、diff、test output 中构建更可靠上下文。
3. zero-parameter tool 更接近 Claude advisor strategy 的产品形态。
4. executor 只需要知道“什么时候该问”，不需要负责“怎么组织上下文”。

可选增强：后续版本允许一个轻量参数：

```ts
{
  focus?: string
}
```

但 MVP 先不要加，以降低复杂度。

---

## 2. 用户体验

### 2.1 默认行为

用户开启 advisor：

```text
/advisor on anthropic/claude-opus-4
```

之后正常使用 Pi Coding Agent。

executor 模型在以下时机主动调用：

```text
advisor()
```

TUI 中显示：

```text
🧠 advisor: COURSE_CORRECT · 3 actions · 812 tokens · 4.2s
```

展开后显示：

```text
VERDICT: COURSE_CORRECT
WHY: 当前方案遗漏了配置文件加载路径，直接修改主入口可能导致测试仍失败。
NEXT_ACTIONS:
1. 先定位 config loader 的调用链。
2. 添加最小测试覆盖缺失路径。
3. 再修改入口处默认值合并逻辑。
RISKS:
- 不要把用户级配置和项目级配置合并顺序反过来。
VERIFY:
- 运行 config 相关单测。
- 再运行受影响 command 的集成测试。
```

### 2.2 手动咨询

用户可以主动触发：

```text
/advisor ask
```

extension 立即构建当前上下文并咨询 advisor，把结果插入当前会话。

### 2.3 失败行为

advisor 失败时，不应该中断主 agent loop。

返回给 executor：

```text
Advisor call failed: provider timeout. Continue with local evidence and verification.
```

---

## 3. 高层架构

```text
pi-advisor-extension/
  package.json
  pi-package.json
  index.ts

  src/
    config.ts
    tool.ts
    commands.ts
    prompt.ts
    transcript.ts
    stage.ts
    budget.ts
    redaction.ts
    adapter/
      pi-ai.ts
      external-cli.ts
    render.ts
    eval/
      benchmark.ts
      tasks.ts
```

模块职责：

```text
config.ts
  读取、写入 advisor 配置。

commands.ts
  实现 /advisor on/off/status/config/ask。

tool.ts
  注册 advisor() tool。

prompt.ts
  维护 executor prompt injection 和 advisor system prompt。

transcript.ts
  从 Pi session branch、recent context entries、tool results、diff/test signal 中构建 advisor context。

stage.ts
  判断当前 advisor call 处于 initial / implementation / recovery / final-check 哪个阶段。

budget.ts
  控制 maxUsesPerRun、maxContextMessages、maxOutputTokens、成本统计。

redaction.ts
  对 secret、token、.env、private key、敏感 diff 行做脱敏。

adapter/pi-ai.ts
  默认模型调用后端，复用 Pi/provider 系统。

adapter/external-cli.ts
  可选后端，通过外部 CLI 调用 Claude/Codex 等。

render.ts
  自定义 TUI 展示 advisor call 和 result。
```

---

## 4. 配置设计

默认配置文件：

```text
~/.pi/agent/advisor.json
```

示例配置：

```json
{
  "enabled": true,
  "provider": "anthropic",
  "model": "claude-opus-4",
  "reasoning": "high",
  "maxUsesPerRun": 3,
  "maxContextMessages": 24,
  "maxAdvisorOutputTokens": 1200,
  "strictBeforeFirstWrite": false,
  "redactSecrets": true,
  "mode": "pi-ai",
  "externalCli": {
    "enabled": false,
    "command": "claude",
    "args": ["--model", "opus"],
    "resume": true
  }
}
```

TypeScript 类型：

```ts
export type AdvisorConfig = {
  enabled: boolean;
  provider: string;
  model: string;
  reasoning?: "low" | "medium" | "high";
  maxUsesPerRun: number;
  maxContextMessages: number;
  maxAdvisorOutputTokens: number;
  strictBeforeFirstWrite: boolean;
  redactSecrets: boolean;
  mode: "pi-ai" | "external-cli";
  externalCli?: {
    enabled: boolean;
    command: string;
    args: string[];
    resume: boolean;
  };
};
```

默认值：

```ts
export const DEFAULT_ADVISOR_CONFIG: AdvisorConfig = {
  enabled: false,
  provider: "anthropic",
  model: "claude-opus-4",
  reasoning: "high",
  maxUsesPerRun: 3,
  maxContextMessages: 24,
  maxAdvisorOutputTokens: 1200,
  strictBeforeFirstWrite: false,
  redactSecrets: true,
  mode: "pi-ai",
  externalCli: {
    enabled: false,
    command: "claude",
    args: [],
    resume: true
  }
};
```

---

## 5. Executor Prompt Injection

在 `before_agent_start` 阶段向 executor 模型注入 advisor 使用规则。

注入内容：

```text
You have access to advisor(), a zero-parameter tool backed by a stronger reviewer model.

Call advisor:
- after initial orientation on complex coding tasks, before substantive edits;
- when tests/errors repeat or the approach is not converging;
- before declaring a non-trivial task done, after writing files and running verification.

Do not call advisor:
- for trivial one-line changes;
- before reading any relevant files;
- after every small tool call;
- as an implementation worker.

The advisor cannot edit files or run commands. Treat its output as strategic guidance.
If local evidence contradicts advisor advice, verify with tools; if still conflicted, call advisor once more with the new evidence in context.
```

实现伪代码：

```ts
pi.on("before_agent_start", async (event, ctx) => {
  state.startRun();

  if (!config.enabled) return;

  return {
    systemPrompt:
      event.systemPrompt +
      "\n\n" +
      buildExecutorAdvisorGuidance(config)
  };
});
```

---

## 6. advisor() Tool 设计

### 6.1 Tool schema

MVP：zero-parameter。

```ts
parameters: Type.Object({})
```

tool 描述：

```ts
pi.registerTool({
  name: "advisor",
  label: "Advisor",
  description:
    "Consult a stronger reviewer model for strategic coding guidance. The advisor sees the current session context and returns a concise plan, correction, or stop signal. It cannot edit files or run commands.",
  promptSnippet:
    "advisor: ask a stronger reviewer model for strategic guidance before major coding decisions, when stuck, and before declaring complex tasks done.",
  promptGuidelines: [
    "Use advisor after initial orientation and before substantive edits on complex tasks.",
    "Use advisor when errors repeat, tests fail unexpectedly, or the current approach may be wrong.",
    "Use advisor before declaring a non-trivial coding task complete, after writing changes and running verification."
  ],
  parameters: Type.Object({}),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // implementation
  }
});
```

### 6.2 Tool execution flow

```text
1. 检查 advisor 是否 enabled。
2. 检查 maxUsesPerRun 是否超限。
3. 检测当前 stage。
4. 构建 curated transcript。
5. redaction。
6. 调用 advisor model。
7. 解析并规范化 advisor 输出。
8. 记录 usage / elapsedMs / stage / truncation 信息。
9. 返回 tool_result 给 executor。
```

伪代码：

```ts
async execute(toolCallId, _params, signal, onUpdate, ctx) {
  if (!config.enabled) {
    return textResult("Advisor is disabled.");
  }

  if (state.callsThisRun >= config.maxUsesPerRun) {
    return textResult("Advisor budget exceeded for this run. Continue without advisor.");
  }

  onUpdate?.(textResult("Building advisor context..."));

  const stage = detectStage(ctx, state);
  const transcript = await buildCuratedTranscript(ctx, {
    maxMessages: config.maxContextMessages,
    redactSecrets: config.redactSecrets,
    stage
  });

  onUpdate?.(
    textResult(`Consulting advisor (${config.provider}/${config.model})...`)
  );

  const advice = await callAdvisorModel({
    config,
    stage,
    transcript,
    signal
  });

  state.recordAdvisorCall(advice);

  return {
    content: [
      {
        type: "text",
        text: formatAdviceForExecutor(advice)
      }
    ],
    details: {
      advisorModel: `${config.provider}/${config.model}`,
      stage,
      usage: advice.usage,
      elapsedMs: advice.elapsedMs,
      truncated: transcript.truncated
    }
  };
}
```

---

## 7. Advisor Prompt

advisor 模型应该作为 senior reviewer / strategist，而不是 implementation worker。

System prompt：

```text
You are a senior coding advisor for a coding agent.

You will receive a curated transcript of the executor's session.
The executor, not you, owns all file edits, commands, and user-facing output.
You must not ask the user questions unless the executor truly cannot proceed.
Return concise strategic guidance only.

Your job:
1. Identify whether the executor is on track.
2. Point out missing constraints, risky assumptions, or likely failure modes.
3. Recommend the next 1-5 concrete actions.
4. If the task appears complete, say what must be verified before final answer.
5. If the executor should stop or revert, say so clearly.

Output format:
VERDICT: ON_TRACK | COURSE_CORRECT | NOT_DONE | STOP
WHY: one short paragraph
NEXT_ACTIONS:
1. ...
2. ...
RISKS:
- ...
VERIFY:
- ...
```

输出控制：

```text
- 默认 max output tokens: 1200
- 不允许输出完整 patch
- 不允许让 advisor 调用工具
- 不允许让 advisor 直接写用户 final answer
- 建议必须短、明确、可执行
```

---

## 8. Context 构建策略

不要把完整 raw transcript 无脑传给高等级模型。需要构建 curated context。

### 8.1 Context 模板

```text
<task>
用户最初目标 + 最近用户补充
</task>

<executor_state>
当前主模型 provider/model/thinking
当前工作目录
当前 active tools
当前 stage: initial | implementation | recovery | final-check
advisor call count
</executor_state>

<project_signals>
git status
git diff --stat
最近修改文件列表
最近失败测试 / 报错摘要
</project_signals>

<recent_transcript>
首条用户任务
最近 N 条 assistant/tool/user message
重要 tool calls/results 摘要
</recent_transcript>

<constraints>
用户显式约束
AGENTS.md / SYSTEM.md 的高优先级规则摘要
</constraints>
```

### 8.2 保留内容

```text
- 原始用户任务
- 最新用户 steering / follow-up
- 最近 N 条消息
- 最近失败的 bash/test 输出尾部
- 相关文件路径
- git diff summary
- 已经执行过的关键决策
- 被修改文件列表
- 当前错误栈摘要
```

### 8.3 丢弃或摘要内容

```text
- 大段 read 输出
- 重复 grep 结果
- 长日志
- 安装依赖的普通输出
- 无关文件内容
- 重复 tool call
- 过早的中间推理
```

### 8.4 Tool result truncation

建议规则：

```text
每个 tool result 最多保留 200 行或 12KB。
失败测试输出保留头部 40 行 + 尾部 120 行。
长文件 read 输出转为 path + excerpt + summary。
重复 grep 只保留最相关 20 条。
```

伪代码：

```ts
function summarizeToolResult(entry: ContextEntry): SummarizedEntry {
  if (entry.tool === "bash" && entry.exitCode !== 0) {
    return keepHeadAndTail(entry.output, { headLines: 40, tailLines: 120 });
  }

  if (entry.output.length > MAX_TOOL_RESULT_CHARS) {
    return {
      ...entry,
      output: truncateMiddle(entry.output, MAX_TOOL_RESULT_CHARS),
      truncated: true
    };
  }

  return entry;
}
```

---

## 9. Stage Detection

advisor 的价值取决于调用时机。建议识别四种 stage。

```ts
type AdvisorStage =
  | "initial"
  | "implementation"
  | "recovery"
  | "final-check";
```

### 9.1 initial

特征：

```text
- 已经 read/grep/list 过相关文件
- 尚未 edit/write
- 即将制定方案
```

advisor 目标：

```text
- 检查是否看错入口
- 提醒需要读哪些文件
- 给出修改策略
```

### 9.2 implementation

特征：

```text
- 已开始修改文件
- 尚未明显失败
```

advisor 目标：

```text
- 检查当前 patch 方向
- 提醒测试覆盖
- 指出设计风险
```

### 9.3 recovery

特征：

```text
- bash/test 多次失败
- 同类错误重复出现
- executor 可能卡住
```

advisor 目标：

```text
- course correction
- 提醒更小复现
- 识别错误根因
- 建议是否 revert 或换方案
```

### 9.4 final-check

特征：

```text
- 已有 diff
- 已运行至少一次验证
- executor 准备最终回答
```

advisor 目标：

```text
- 检查是否真的完成
- 提醒遗漏测试
- 检查用户原始需求是否全部满足
- 判断是否可以 final
```

伪代码：

```ts
function detectStage(ctx: ToolContext, state: AdvisorRunState): AdvisorStage {
  const hasMutation = state.mutationSeen || hasEditWriteCalls(ctx);
  const hasFailures = countRecentFailedCommands(ctx) >= 2;
  const hasVerification = hasRecentTestOrBuildCommand(ctx);
  const isNearFinal = hasMutation && hasVerification && looksLikePreparingFinal(ctx);

  if (hasFailures) return "recovery";
  if (isNearFinal) return "final-check";
  if (hasMutation) return "implementation";
  return "initial";
}
```

---

## 10. Budget 与状态管理

每个 run 维护：

```ts
type AdvisorRunState = {
  runId: string;
  callsThisRun: number;
  callsThisSession: number;
  firstCallTurn?: number;
  lastCallAt?: number;
  advisorCalledBeforeMutation: boolean;
  mutationSeen: boolean;
  lastAdvisorDigest?: string;
};
```

预算规则：

```text
maxUsesPerRun: 默认 3
maxAdvisorOutputTokens: 默认 1200
maxContextMessages: 默认 24
超预算：返回 budget exceeded，executor 继续自己做
失败：返回 error summary，不让整个 Pi run 崩掉
```

异常处理：

```ts
try {
  const advice = await callAdvisorModel(...);
  return formatAdviceForExecutor(advice);
} catch (error) {
  return textResult(
    `Advisor call failed: ${formatError(error)}. Continue with local evidence and verification.`
  );
}
```

---

## 11. Strict Gate：第一次写入前强制 Advisor

MVP 先默认关闭。

配置项：

```json
{
  "strictBeforeFirstWrite": false
}
```

开启后，在复杂 coding task 中，第一次状态改变前必须先调用 advisor。

状态改变包括：

```text
- write
- edit
- patch
- bash 中的 rm / mv / cp / npm install / git 等潜在修改命令
```

伪代码：

```ts
pi.on("tool_call", async (event, ctx) => {
  if (!config.strictBeforeFirstWrite) return;

  const isStateChanging =
    event.toolName === "write" ||
    event.toolName === "edit" ||
    looksStateChangingBash(event);

  if (isAdvisorToolCall(event)) {
    state.advisorCalledBeforeMutation = true;
    return;
  }

  if (isStateChanging && !state.advisorCalledBeforeMutation) {
    return {
      block: true,
      reason:
        "Call advisor() before the first state-changing action on this complex task."
    };
  }
});
```

注意：

```text
- 不要对 trivial task 强制开启。
- 可以加 task complexity heuristic。
- 可以允许用户通过 /advisor config strictBeforeFirstWrite=false 临时关闭。
```

---

## 12. Provider Adapter

### 12.1 Pi-native backend

默认后端。

优点：

```text
- 复用 Pi provider/model registry
- 复用已有 API key 管理
- 复用 reasoning effort 配置
- extension 安装体验更简单
```

调用接口建议：

```ts
type AdvisorRequest = {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  model: string;
  provider: string;
  reasoning?: "low" | "medium" | "high";
  maxTokens: number;
  signal: AbortSignal;
};
```

返回：

```ts
type AdvisorResponse = {
  text: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  elapsedMs: number;
};
```

### 12.2 External CLI backend

后续版本支持。

适用场景：

```text
- 用户已经登录 Claude CLI / Codex CLI
- 不想在 Pi 里重复配置 API key
- 希望利用外部 CLI 的 session resume 能力
```

调用方式：

```text
extension 构建 curated context
  ↓
stdin 传给 external CLI
  ↓
读取 stdout
  ↓
解析 advisor 输出
  ↓
返回给 executor
```

伪代码：

```ts
async function callExternalCliAdvisor(req: AdvisorRequest): Promise<AdvisorResponse> {
  const child = spawn(config.externalCli.command, config.externalCli.args, {
    stdio: ["pipe", "pipe", "pipe"]
  });

  child.stdin.write(renderAdvisorCliInput(req));
  child.stdin.end();

  const { stdout, stderr, elapsedMs } = await collectProcessOutput(child, {
    signal: req.signal,
    timeoutMs: 120_000
  });

  if (stderr && !stdout) {
    throw new Error(stderr);
  }

  return {
    text: stdout.trim(),
    elapsedMs
  };
}
```

---

## 13. Secret Redaction

默认开启：

```json
{
  "redactSecrets": true
}
```

需要脱敏的内容：

```text
- API keys
- access tokens
- refresh tokens
- passwords
- .env 文件内容
- SSH private keys
- PEM blocks
- JWT
- GitHub / OpenAI / Anthropic / AWS / GCP / Azure token patterns
- Authorization headers
- cookies
```

伪代码：

```ts
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /ghp_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /Authorization:\s*Bearer\s+[A-Za-z0-9._-]+/gi,
  /password\s*=\s*[^\n]+/gi,
  /token\s*=\s*[^\n]+/gi
];

function redactSecrets(text: string): string {
  let output = text;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, "[REDACTED]");
  }
  return output;
}
```

对 `.env` 或疑似 secret 文件：

```text
不要发送原文。
只发送：path + key names summary。
```

示例：

```text
.env detected. Redacted. Keys present: OPENAI_API_KEY, DATABASE_URL, NEXTAUTH_SECRET.
```

---

## 14. TUI Rendering

默认折叠展示：

```text
🧠 advisor: ON_TRACK · 2 actions · 640 tokens · 3.1s
```

详细展示：

```text
Advisor model: anthropic/claude-opus-4
Stage: final-check
Context: 21 messages, truncated=true
Usage: input=10421, output=640
Elapsed: 3.1s

VERDICT: ON_TRACK
WHY: ...
NEXT_ACTIONS:
1. ...
RISKS:
- ...
VERIFY:
- ...
```

结果 details：

```ts
{
  advisorModel: "anthropic/claude-opus-4",
  stage: "final-check",
  usage: {
    inputTokens: 10421,
    outputTokens: 640,
    totalTokens: 11061
  },
  elapsedMs: 3100,
  contextMessages: 21,
  truncated: true
}
```

---

## 15. Commands 实现

### 15.1 `/advisor status`

输出：

```text
Advisor: enabled
Backend: pi-ai
Model: anthropic/claude-opus-4
Reasoning: high
Max uses per run: 3
Strict before first write: false
Redaction: true
Calls this session: 7
```

### 15.2 `/advisor on`

```text
/advisor on
/advisor on anthropic/claude-opus-4
/advisor on openai/gpt-5.5-pro
```

行为：

```text
- enabled=true
- 如果提供 provider/model，则更新配置
- 写入 config file
```

### 15.3 `/advisor off`

```text
- enabled=false
- 写入 config file
```

### 15.4 `/advisor config`

查看所有配置：

```text
/advisor config
```

设置单项配置：

```text
/advisor config maxUsesPerRun=2
/advisor config maxContextMessages=18
/advisor config strictBeforeFirstWrite=true
/advisor config redactSecrets=true
```

### 15.5 `/advisor ask`

立即执行一次 advisor call。

```text
/advisor ask
```

可选增强：

```text
/advisor ask 为什么测试一直失败？
```

MVP 可先不支持自定义问题。

---

## 16. 完整入口伪代码

```ts
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadAdvisorConfig, saveAdvisorConfig } from "./src/config";
import { createAdvisorCommand } from "./src/commands";
import { buildExecutorAdvisorGuidance, buildAdvisorSystemPrompt } from "./src/prompt";
import { buildCuratedTranscript } from "./src/transcript";
import { detectStage } from "./src/stage";
import { createAdvisorState } from "./src/budget";
import { callAdvisorModel } from "./src/adapter/pi-ai";
import { renderAdvisorCall, renderAdvisorResult } from "./src/render";

export default function advisorExtension(pi: ExtensionAPI) {
  const config = loadAdvisorConfig();
  const state = createAdvisorState();

  pi.registerCommand("advisor", createAdvisorCommand(pi, config, state));

  pi.on("before_agent_start", async (event, ctx) => {
    state.startRun();

    if (!config.enabled) return;

    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n" +
        buildExecutorAdvisorGuidance(config)
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!config.enabled) return;

    if (isAdvisorToolCall(event)) {
      state.markAdvisorCalled();
      return;
    }

    if (isStateChangingToolCall(event)) {
      state.markMutationSeen();
    }

    if (
      config.strictBeforeFirstWrite &&
      isStateChangingToolCall(event) &&
      !state.advisorCalledBeforeMutation
    ) {
      return {
        block: true,
        reason:
          "Call advisor() before the first state-changing action on this complex task."
      };
    }
  });

  pi.registerTool({
    name: "advisor",
    label: "Advisor",
    description:
      "Consult a stronger reviewer model for strategic guidance. Takes no parameters.",
    promptSnippet:
      "advisor: consult a stronger model before major coding decisions, when stuck, and before final completion.",
    promptGuidelines: [
      "Use advisor after initial orientation and before substantive coding on complex tasks.",
      "Use advisor when repeated errors, failing tests, or uncertainty suggest a wrong approach.",
      "Use advisor before declaring a non-trivial coding task complete, after verification."
    ],
    parameters: Type.Object({}),

    async execute(toolCallId, _params, signal, onUpdate, ctx) {
      if (!config.enabled) {
        return textResult("Advisor is disabled.");
      }

      if (state.callsThisRun >= config.maxUsesPerRun) {
        return textResult(
          "Advisor budget exceeded for this run. Continue without advisor."
        );
      }

      try {
        onUpdate?.(textResult("Building advisor context..."));

        const stage = detectStage(ctx, state);
        const transcript = await buildCuratedTranscript(ctx, {
          maxMessages: config.maxContextMessages,
          redactSecrets: config.redactSecrets,
          stage
        });

        onUpdate?.(
          textResult(
            `Consulting advisor (${config.provider}/${config.model})...`
          )
        );

        const advice = await callAdvisorModel({
          config,
          system: buildAdvisorSystemPrompt(),
          transcript,
          stage,
          signal,
          maxTokens: config.maxAdvisorOutputTokens
        });

        state.recordAdvisorCall(advice);

        return {
          content: [
            {
              type: "text",
              text: normalizeAdvisorOutput(advice.text)
            }
          ],
          details: {
            advisorModel: `${config.provider}/${config.model}`,
            stage,
            usage: advice.usage,
            elapsedMs: advice.elapsedMs,
            contextMessages: transcript.messageCount,
            truncated: transcript.truncated
          }
        };
      } catch (error) {
        return textResult(
          `Advisor call failed: ${formatError(error)}. Continue with local evidence and verification.`
        );
      }
    },

    renderCall: renderAdvisorCall,
    renderResult: renderAdvisorResult
  });
}
```

---

## 17. 验收标准

### Phase 1 MVP

必须满足：

```text
- extension 能被 Pi 加载。
- /advisor on/off/status 可用。
- advisor() 出现在 executor 可用 tool 列表中。
- cheap executor 能主动调用 advisor()。
- advisor 返回内容以 tool_result 形式进入 executor 上下文。
- executor 能根据 advisor 建议继续 edit/write/bash。
- maxUsesPerRun 生效。
- advisor provider 调用失败不会导致主任务失败。
```

### Phase 2 质量控制

必须满足：

```text
- stage detection 可区分 initial / implementation / recovery / final-check。
- curated transcript 不包含明显无关长日志。
- secret redaction 默认开启并覆盖常见 token。
- git diff/test output summary 可用。
- final-check advisor 能指出遗漏验证。
- recovery advisor 能在重复失败时提供 course correction。
```

### Phase 3 高级后端

必须满足：

```text
- external-cli backend 可用。
- external CLI stdout/stderr/timeout 处理稳定。
- 可配置 CLI command/args。
- 可选 resume advisor session。
```

### Phase 4 发布

必须满足：

```text
- README 完整。
- pi-package manifest 完整。
- 示例配置完整。
- 包可安装。
- 有至少 5 个 demo coding tasks。
- 有 cheap model alone vs cheap+advisor 的评估结果。
```

---

## 18. 评估方案

对比三种模式：

```text
A. cheap model alone
B. cheap model + advisor extension
C. strong model alone
```

测试任务类型：

```text
- 小型 bug fix
- 多文件 refactor
- 测试失败修复
- 配置系统修改
- CLI 行为变更
- 类型错误修复
- 需要先理解架构的 feature task
```

指标：

```text
- task pass rate
- tests pass rate
- average tool calls
- average turns
- advisor calls per run
- total token cost
- latency
- human intervention count
- bad edit rate
- revert count
```

期望结果：

```text
cheap + advisor 的成本明显低于 strong model alone。
cheap + advisor 的成功率明显高于 cheap model alone。
advisor 平均调用次数保持在 1-3 次。
```

---

## 19. 实现优先级

### P0

```text
- advisor() zero-parameter tool
- /advisor on/off/status
- config file
- Pi-native model adapter
- basic curated transcript
- basic prompt injection
- maxUsesPerRun
```

### P1

```text
- redaction
- stage detection
- git diff summary
- test output summary
- TUI compact rendering
- /advisor config
```

### P2

```text
- /advisor ask
- strictBeforeFirstWrite
- external-cli backend
- external CLI resume
- cost/usage stats
```

### P3

```text
- benchmark harness
- package publishing
- docs
- examples
- community feedback loop
```

---

## 20. 关键取舍

### 20.1 不做 full sub-agent

advisor 不应该拥有自己的 tool loop。

原因：

```text
- 成本更高
- 上下文更复杂
- 容易和 executor 竞争控制权
- 更难做安全边界
- Pi extension MVP 实现复杂度上升
```

### 20.2 不让 advisor 写 patch

advisor 可以建议修改方向，但不直接输出完整 patch。

原因：

```text
- executor 才拥有本地文件状态
- advisor 的上下文是 curated，不一定完整
- 避免出现 patch 与当前工作区不一致
```

### 20.3 少量高价值调用

理想调用次数：

```text
简单任务：0 次
中等任务：1 次
复杂任务：2-3 次
卡住任务：最多 3 次
```

### 20.4 Context 质量比 Context 数量重要

不要把大量无关 read 输出、grep 输出、安装日志直接塞给 advisor。

更好的 advisor context 应该包括：

```text
- 用户目标
- 当前假设
- 已读关键文件
- 已改文件
- 当前 diff summary
- 失败测试摘要
- executor 准备采取的下一步
```

---

## 21. 风险与缓解

### 风险 1：executor 过度调用 advisor

缓解：

```text
- maxUsesPerRun 默认 3
- prompt 明确 trivial task 不调用
- TUI 暴露调用次数
- 后续加入 cost warning
```

### 风险 2：advisor 上下文不足导致误导

缓解：

```text
- initial call 必须发生在 orientation 之后
- context 中包含 evidence summary
- advisor prompt 要求指出不确定性
- executor 不盲从 advisor，必须用工具验证
```

### 风险 3：泄露 secret

缓解：

```text
- 默认 redaction
- .env 不传原文
- diff secret line redaction
- provider 配置说明
```

### 风险 4：延迟增加

缓解：

```text
- advisor 输出 token 限制
- context message 限制
- 默认只在关键节点调用
- provider timeout
```

### 风险 5：实现依赖 Pi 内部 API 变化

缓解：

```text
- extension 内集中封装 Pi context access
- adapter 层隔离 provider 调用
- README 标明兼容 Pi 版本
```

---

## 22. 参考资料

- Anthropic, “The advisor strategy”: https://claude.com/blog/the-advisor-strategy
- Anthropic Docs, “Advisor tool”: https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool
- Pi Coding Agent: https://pi.dev/
- Pi Extensions Docs: https://pi.dev/docs/latest/extensions
- Pi package example, `pi-advisor`: https://pi.dev/packages/pi-advisor
- Pi package example, `@juicesharp/rpiv-advisor`: https://pi.dev/packages/%40juicesharp/rpiv-advisor
- Pi package example, `pi-external-advisor`: https://pi.dev/packages/pi-external-advisor
