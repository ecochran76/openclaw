import crypto from "node:crypto";
import { Type } from "typebox";
import { resolveAutomationConfig } from "../../automation/config.js";
import {
  getAutomationRun,
  isAutomationRunTerminalState,
  listAutomationRunsForRequester,
  resolveAutomationRunSelector,
  resetAutomationRegistryForTests,
  setAutomationRunPendingOperatorNote,
} from "../../automation/registry.js";
import {
  requestAutomationRunStop,
  resetAutomationRunnerForTests,
  startAutomationRunInBackground,
  type AutomationTurnUpdateDelivery,
  type AutomationWorkerTurnInput,
  type AutomationWorkerTurnResult,
} from "../../automation/runner.js";
import {
  buildAutomationCompactStatusLine,
  buildAutomationListText,
  buildAutomationStatusText,
} from "../../automation/status.js";
import { createDefaultDeps } from "../../cli/deps.js";
import { createOutboundSendDeps, type CliDeps } from "../../cli/outbound-send-deps.js";
import { loadConfig, type OpenClawConfig } from "../../config/config.js";
import { runCronIsolatedAgentTurn } from "../../cron/isolated-agent.js";
import type { CronJob } from "../../cron/types.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { stringEnum } from "../schema/typebox.js";
import {
  type AnyAgentTool,
  jsonResult,
  readNumberParam,
  readStringParam,
  ToolInputError,
} from "./common.js";

const AUTOMATION_ACTIONS = ["run", "list", "status", "steer", "stop"] as const;
const CONTROL_RESULTS = ["completed", "progress", "blocked", "approval_required", "error"] as const;
type ControlResult = (typeof CONTROL_RESULTS)[number];

const AutomationToolSchema = Type.Object({
  action: stringEnum(AUTOMATION_ACTIONS),
  goal: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  selector: Type.Optional(Type.String()),
  runId: Type.Optional(Type.String()),
  id: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  maxTurns: Type.Optional(Type.Number({ minimum: 1 })),
  maxTokens: Type.Optional(Type.Number({ minimum: 1 })),
  maxDurationSeconds: Type.Optional(Type.Number({ minimum: 1 })),
});

export type AutomationToolDeps = {
  cliDeps?: CliDeps;
  executeWorkerTurn?: (input: AutomationWorkerTurnInput) => Promise<AutomationWorkerTurnResult>;
  deliverTurnUpdate?: (params: { updateText: string; runId: string }) => Promise<void> | void;
  deliverFinalSummary?: (params: { summaryText: string; runId: string }) => Promise<void> | void;
};

type AutomationToolOptions = {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentTo?: string;
  agentThreadId?: string | number;
  currentChannelId?: string;
  currentThreadTs?: string;
  agentAccountId?: string;
  config?: OpenClawConfig;
};

function resolveConfig(config?: OpenClawConfig): OpenClawConfig {
  return config ?? loadConfig();
}

function resolveSelector(params: Record<string, unknown>): string | undefined {
  return (
    readStringParam(params, "selector") ??
    readStringParam(params, "runId") ??
    readStringParam(params, "id")
  );
}

function buildChildSessionKey(agentId: string): string {
  return `agent:${agentId}:subagent:auto-${crypto.randomUUID()}`;
}

function buildWorkerControlPrompt(prompt: string): string {
  return [
    prompt.trim(),
    "",
    "Return format requirements:",
    "- First line must be exactly one of: RESULT: completed, RESULT: progress, RESULT: blocked, RESULT: approval_required, RESULT: error",
    "- After the first line, include only the substantive result text.",
    "- Use RESULT: progress only when there is meaningful progress and another worker turn is still needed.",
  ].join("\n");
}

function parseWorkerControlResult(text?: string): {
  control?: ControlResult;
  body?: string;
} {
  const normalized = text?.trim();
  if (!normalized) {
    return {};
  }
  const match = normalized.match(
    /^RESULT:\s*(completed|progress|blocked|approval_required|error)\s*\n?/i,
  );
  if (!match) {
    return { body: normalized };
  }
  const control = match[1]?.toLowerCase() as ControlResult;
  const body = normalized.slice(match[0].length).trim();
  return { control, body: body || undefined };
}

export function mapRunResultToWorkerTurnResult(
  result: Awaited<ReturnType<typeof runCronIsolatedAgentTurn>>,
): AutomationWorkerTurnResult {
  const rawText = result.outputText?.trim() || result.summary?.trim() || undefined;
  const parsed = parseWorkerControlResult(rawText);
  const outputText = parsed.body ?? rawText;
  const totalTokensCandidate =
    result.usage?.total_tokens ??
    (result.usage?.input_tokens ?? 0) + (result.usage?.output_tokens ?? 0);
  const totalTokensUsedDelta = totalTokensCandidate > 0 ? totalTokensCandidate : undefined;

  if (result.status === "error") {
    // Isolated runs can surface recovered tool warnings as an overall "error"
    // while still returning a structured worker result body. For automation,
    // trust an explicit control line when the worker produced substantive text.
    if (parsed.control && outputText) {
      switch (parsed.control) {
        case "progress":
          return { outputText, progressText: outputText, totalTokensUsedDelta };
        case "blocked":
          return { outputText, totalTokensUsedDelta, blocked: true };
        case "approval_required":
          return { outputText, totalTokensUsedDelta, approvalRequired: true };
        case "error":
          return { outputText, totalTokensUsedDelta, errored: true };
        case "completed":
        default:
          return {
            outputText,
            finalSummaryText: outputText,
            totalTokensUsedDelta,
            completed: true,
          };
      }
    }
    return {
      outputText,
      totalTokensUsedDelta,
      errored: true,
    };
  }

  switch (parsed.control) {
    case "progress":
      return { outputText, progressText: outputText, totalTokensUsedDelta };
    case "blocked":
      return { outputText, totalTokensUsedDelta, blocked: true };
    case "approval_required":
      return { outputText, totalTokensUsedDelta, approvalRequired: true };
    case "error":
      return { outputText, totalTokensUsedDelta, errored: true };
    case "completed":
    default:
      return { outputText, finalSummaryText: outputText, totalTokensUsedDelta, completed: true };
  }
}

function buildAutomationWorkerJob(input: AutomationWorkerTurnInput): CronJob {
  const now = Date.now();
  return {
    id: `automation-${input.runId}-${input.turnIndex}`,
    sessionKey: input.childSessionKey,
    name: input.label?.trim() || `Automation ${input.runId}`,
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "at", at: new Date(now).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: buildWorkerControlPrompt(input.prompt),
      model: input.model,
      thinking: input.thinking,
      deliver: false,
      timeoutSeconds: 0,
    },
    delivery: { mode: "none" },
    state: {},
  };
}

function resolveAnnounceTarget(opts: AutomationToolOptions): {
  channel?: GatewayMessageChannel;
  to?: string;
  threadId?: string | number;
} {
  const to = opts.agentTo?.trim();
  if (opts.agentChannel && to) {
    return {
      channel: opts.agentChannel,
      to,
      threadId: opts.agentThreadId ?? opts.currentThreadTs,
    };
  }
  if (opts.agentChannel && opts.currentChannelId) {
    return {
      channel: opts.agentChannel,
      to: `channel:${opts.currentChannelId}`,
      threadId: opts.agentThreadId ?? opts.currentThreadTs,
    };
  }
  return {};
}

function createDefaultWorkerTurnExecutor(opts: AutomationToolOptions, cliDeps: CliDeps) {
  const cfg = resolveConfig(opts.config);
  return async (input: AutomationWorkerTurnInput): Promise<AutomationWorkerTurnResult> => {
    const runResult = await runCronIsolatedAgentTurn({
      cfg,
      deps: cliDeps,
      job: buildAutomationWorkerJob(input),
      message: buildWorkerControlPrompt(input.prompt),
      sessionKey: input.childSessionKey,
      agentId: resolveSessionAgentId({ sessionKey: input.childSessionKey, config: cfg }),
      bootstrapContextRunKind: "automation",
    });
    return mapRunResultToWorkerTurnResult(runResult);
  };
}

function createDefaultAnnounceDelivery(opts: AutomationToolOptions, cliDeps: CliDeps) {
  const cfg = resolveConfig(opts.config);
  const target = resolveAnnounceTarget(opts);
  return async (text: string) => {
    if (!target.channel || !target.to || !text.trim()) {
      return;
    }
    await deliverOutboundPayloads({
      cfg,
      channel: target.channel as never,
      to: target.to,
      accountId: opts.agentAccountId,
      threadId: target.threadId,
      payloads: [{ text }],
      deps: createOutboundSendDeps(cliDeps),
      bestEffort: true,
    });
  };
}

export function createAutomationTool(
  opts?: AutomationToolOptions,
  deps?: AutomationToolDeps,
): AnyAgentTool {
  const cfg = resolveConfig(opts?.config);
  const cliDeps = deps?.cliDeps ?? createDefaultDeps();
  const executeWorkerTurn =
    deps?.executeWorkerTurn ?? createDefaultWorkerTurnExecutor(opts ?? {}, cliDeps);
  const announceDelivery = createDefaultAnnounceDelivery(opts ?? {}, cliDeps);
  const deliverTurnUpdate =
    deps?.deliverTurnUpdate ??
    (async ({ updateText }: { updateText: string }) => {
      await announceDelivery(updateText);
    });
  const deliverFinalSummary =
    deps?.deliverFinalSummary ??
    (async ({ summaryText }: { summaryText: string }) => {
      await announceDelivery(summaryText);
    });

  return {
    label: "Automation",
    name: "automation",
    ownerOnly: true,
    description:
      "Run bounded background automation with explicit stop caps. Use this for /automation-style requests, including natural-language asks to start, list, steer, or stop a capped background run for the current session. Do not emulate /automation with sessions_spawn or ACP. Actions: run, list, status, steer, stop.",
    parameters: AutomationToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", {
        required: true,
      }) as (typeof AUTOMATION_ACTIONS)[number];
      const requesterSessionKey = opts?.agentSessionKey?.trim();
      if (!requesterSessionKey) {
        throw new ToolInputError("agent session required");
      }

      if (action === "list") {
        const runs = listAutomationRunsForRequester(requesterSessionKey);
        return jsonResult({
          status: "ok",
          text: buildAutomationListText({ runs }),
          runs,
        });
      }

      if (action === "run") {
        const goal = readStringParam(params, "goal", { required: true });
        const activeRuns = listAutomationRunsForRequester(requesterSessionKey, {
          includeEnded: false,
        });
        const maxConcurrent = resolveAutomationConfig(cfg).maxConcurrent;
        if (activeRuns.length >= maxConcurrent) {
          return jsonResult({
            status: "error",
            error: `automation concurrency limit reached (${activeRuns.length}/${maxConcurrent})`,
            activeRuns: activeRuns.map((run) => ({
              runId: run.runId,
              label: run.label,
              state: run.state,
            })),
          });
        }

        const agentId = resolveSessionAgentId({ sessionKey: requesterSessionKey, config: cfg });
        const record = startAutomationRunInBackground({
          requesterSessionKey,
          childSessionKey: buildChildSessionKey(agentId),
          spec: {
            goal,
            label: readStringParam(params, "label"),
            model: readStringParam(params, "model"),
            thinking: readStringParam(params, "thinking"),
            stop: {
              maxTurns: readNumberParam(params, "maxTurns", { integer: true }),
              maxTokens: readNumberParam(params, "maxTokens", { integer: true }),
              maxDurationSeconds: readNumberParam(params, "maxDurationSeconds", { integer: true }),
            },
            delivery: { mode: "announce" },
          },
          config: cfg,
          deps: {
            runWorkerTurn: executeWorkerTurn,
            deliverTurnUpdate: async ({ run, updateText }: AutomationTurnUpdateDelivery) => {
              await deliverTurnUpdate({ updateText, runId: run.runId });
            },
            deliverFinalSummary: async ({ summaryText, run }) => {
              await deliverFinalSummary({ summaryText, runId: run.runId });
            },
          },
        });
        return jsonResult({
          status: "accepted",
          runId: record.runId,
          childSessionKey: record.childSessionKey,
          text: buildAutomationCompactStatusLine({ run: record }),
        });
      }

      const selector = resolveSelector(params);
      const record = resolveAutomationRunSelector({ requesterSessionKey, selector });
      if (!record) {
        return jsonResult({
          status: "error",
          error: selector ? `automation run not found: ${selector}` : "no automation runs found",
        });
      }

      if (action === "status") {
        const runs = listAutomationRunsForRequester(requesterSessionKey);
        const index = runs.findIndex((entry) => entry.runId === record.runId);
        return jsonResult({
          status: "ok",
          runId: record.runId,
          text: buildAutomationStatusText({
            run: record,
            index: index >= 0 ? index + 1 : undefined,
          }),
          run: getAutomationRun(record.runId) ?? record,
        });
      }

      if (action === "steer") {
        if (isAutomationRunTerminalState(record.state)) {
          return jsonResult({
            status: "error",
            error: `automation run is not active: ${record.runId}`,
          });
        }
        const message = readStringParam(params, "message", { required: true });
        const updated = setAutomationRunPendingOperatorNote(record.runId, message) ?? record;
        const runs = listAutomationRunsForRequester(requesterSessionKey);
        const index = runs.findIndex((entry) => entry.runId === updated.runId);
        return jsonResult({
          status: "ok",
          runId: updated.runId,
          text: buildAutomationStatusText({
            run: updated,
            index: index >= 0 ? index + 1 : undefined,
          }),
          run: updated,
        });
      }

      if (action === "stop") {
        const stopped = requestAutomationRunStop(record.runId);
        const next = stopped ?? getAutomationRun(record.runId) ?? record;
        const runs = listAutomationRunsForRequester(requesterSessionKey);
        const index = runs.findIndex((entry) => entry.runId === next.runId);
        return jsonResult({
          status: "ok",
          runId: next.runId,
          text: buildAutomationStatusText({ run: next, index: index >= 0 ? index + 1 : undefined }),
          run: next,
        });
      }

      throw new ToolInputError("unsupported action");
    },
  };
}

export function resetAutomationToolStateForTests(): void {
  resetAutomationRunnerForTests();
  resetAutomationRegistryForTests();
}
