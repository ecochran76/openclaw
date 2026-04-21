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
import {
  buildAutomationWorkerControlPrompt,
  buildAutomationWorkerJob,
  type AutomationWorkerJob,
} from "../../automation/worker-job.js";
import {
  mapRunResultToWorkerTurnResult,
  type AutomationWorkerRunResult,
} from "../../automation/worker-result.js";
import { loadConfig, type OpenClawConfig } from "../../config/config.js";
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
type AutomationCliDeps = Record<string, unknown>;
type RunCronIsolatedAgentTurn = (params: {
  cfg: OpenClawConfig;
  deps: AutomationCliDeps;
  job: AutomationWorkerJob;
  message: string;
  sessionKey: string;
  agentId: string;
}) => Promise<AutomationWorkerRunResult>;
type DeliverOutboundPayloads = (params: {
  cfg: OpenClawConfig;
  channel: never;
  to: string;
  accountId?: string;
  threadId?: string | number;
  payloads: Array<{ text: string }>;
  deps: unknown;
  bestEffort: boolean;
}) => Promise<unknown>;
type CreateOutboundSendDeps = (deps: AutomationCliDeps) => unknown;

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
  cliDeps?: AutomationCliDeps;
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

function resolveCliDepsModulePath(): "../../cli/deps.js" {
  return "../../cli/deps.js";
}

function resolveOutboundSendDepsModulePath(): "../../cli/outbound-send-deps.js" {
  return "../../cli/outbound-send-deps.js";
}

function resolveCronIsolatedAgentModulePath(): "../../cron/isolated-agent.js" {
  return "../../cron/isolated-agent.js";
}

function resolveOutboundDeliverModulePath(): "../../infra/outbound/deliver.js" {
  return "../../infra/outbound/deliver.js";
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

export { mapRunResultToWorkerTurnResult };

async function resolveAutomationCliDeps(cliDeps?: AutomationCliDeps) {
  if (cliDeps) {
    return cliDeps;
  }
  const { createDefaultDeps } = await import(resolveCliDepsModulePath());
  return createDefaultDeps() as AutomationCliDeps;
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

function createDefaultWorkerTurnExecutor(opts: AutomationToolOptions, cliDeps?: AutomationCliDeps) {
  const cfg = resolveConfig(opts.config);
  return async (input: AutomationWorkerTurnInput): Promise<AutomationWorkerTurnResult> => {
    const [cronModule, resolvedCliDeps] = await Promise.all([
      import(resolveCronIsolatedAgentModulePath()),
      resolveAutomationCliDeps(cliDeps),
    ]);
    const { runCronIsolatedAgentTurn } = cronModule as {
      runCronIsolatedAgentTurn: RunCronIsolatedAgentTurn;
    };
    const runResult = await runCronIsolatedAgentTurn({
      cfg,
      deps: resolvedCliDeps,
      job: buildAutomationWorkerJob(input),
      message: buildAutomationWorkerControlPrompt(input.prompt),
      sessionKey: input.childSessionKey,
      agentId: resolveSessionAgentId({ sessionKey: input.childSessionKey, config: cfg }),
    });
    return mapRunResultToWorkerTurnResult(runResult);
  };
}

function createDefaultAnnounceDelivery(opts: AutomationToolOptions, cliDeps?: AutomationCliDeps) {
  const cfg = resolveConfig(opts.config);
  const target = resolveAnnounceTarget(opts);
  return async (text: string) => {
    if (!target.channel || !target.to || !text.trim()) {
      return;
    }
    const [deliverModule, outboundDepsModule, resolvedCliDeps] = await Promise.all([
      import(resolveOutboundDeliverModulePath()),
      import(resolveOutboundSendDepsModulePath()),
      resolveAutomationCliDeps(cliDeps),
    ]);
    const { deliverOutboundPayloads } = deliverModule as {
      deliverOutboundPayloads: DeliverOutboundPayloads;
    };
    const { createOutboundSendDeps } = outboundDepsModule as {
      createOutboundSendDeps: CreateOutboundSendDeps;
    };
    await deliverOutboundPayloads({
      cfg,
      channel: target.channel as never,
      to: target.to,
      accountId: opts.agentAccountId,
      threadId: target.threadId,
      payloads: [{ text }],
      deps: createOutboundSendDeps(resolvedCliDeps),
      bestEffort: true,
    });
  };
}

export function createAutomationTool(
  opts?: AutomationToolOptions,
  deps?: AutomationToolDeps,
): AnyAgentTool {
  const cfg = resolveConfig(opts?.config);
  const cliDeps = deps?.cliDeps;
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
