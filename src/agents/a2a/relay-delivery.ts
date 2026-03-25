import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { buildAgentToAgentRelayText } from "../tools/sessions-send-helpers.js";
import type {
  RelayAttemptResult,
  RelayResult,
  RelaySummaryParams,
  RelayTargetResult,
  RelayTurnParams,
} from "./types.js";

export type RelayDeliveryLogger = {
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

export type RelayDeliveryDeps = {
  callGateway?: typeof callGateway;
  logger?: RelayDeliveryLogger;
};

const log = createSubsystemLogger("agents/sessions-send");

function resolveRelayDeliveryDeps(overrides?: RelayDeliveryDeps) {
  return {
    callGateway: overrides?.callGateway ?? callGateway,
    logger: overrides?.logger ?? log,
  };
}

export function buildRelaySummary(params: RelaySummaryParams): RelayResult {
  const mode = params.policy?.mode ?? "target-only";
  const mirrorTurns = params.policy?.mirrorTurns ?? "round1";
  if (params.policy?.enabled !== true) {
    return { status: "disabled", mode, mirrorTurns, targets: [] };
  }
  if (params.blocked) {
    return { status: "blocked", mode, mirrorTurns, targets: params.targets };
  }
  if (params.targets.length === 0) {
    return { status: "not_applicable", mode, mirrorTurns, targets: [] };
  }
  const sentCount = params.targets.filter((target) => target.status === "sent").length;
  const failureCount = params.targets.filter(
    (target) => target.status === "failed" || target.status === "blocked",
  ).length;
  if (failureCount === 0) {
    return {
      status: sentCount > 0 ? "sent" : "not_applicable",
      mode,
      mirrorTurns,
      targets: params.targets,
    };
  }
  if (sentCount === 0) {
    return { status: "failed", mode, mirrorTurns, targets: params.targets };
  }
  return { status: "partial", mode, mirrorTurns, targets: params.targets };
}

export async function relayTurn(
  params: RelayTurnParams,
  deps?: RelayDeliveryDeps,
): Promise<RelayAttemptResult> {
  const { callGateway: gatewayCall, logger } = resolveRelayDeliveryDeps(deps);
  const policy = params.relayPolicy;
  if (policy?.enabled !== true) {
    return { status: "not_applicable", targets: [], requiredFailure: false };
  }
  if (!params.text.trim()) {
    return { status: "not_applicable", targets: [], requiredFailure: false };
  }
  const relayText = buildAgentToAgentRelayText({
    handoffId: params.runContextId,
    fromAgent: params.fromAgent,
    toAgent: params.toAgent,
    text: params.text,
    verbosity: policy.verbosity,
  });
  if (!relayText.trim()) {
    return { status: "not_applicable", targets: [], requiredFailure: false };
  }

  const targetSpecs = (
    policy.mode === "dual-channel"
      ? [
          { role: "source" as const, target: params.sourceRelayTarget },
          { role: "target" as const, target: params.targetRelayTarget },
        ]
      : [{ role: "target" as const, target: params.targetRelayTarget }]
  ).map(({ role, target }) => ({
    role,
    target,
    required: true,
  }));

  const results: RelayTargetResult[] = [];
  for (const [index, spec] of targetSpecs.entries()) {
    if (!spec.target) {
      const unresolved: RelayTargetResult = {
        role: spec.role,
        status: policy.requireDelivery ? "blocked" : "failed",
        error: "No relay target could be resolved.",
      };
      results.push(unresolved);
      if (spec.required && policy.requireDelivery) {
        return { status: "blocked", targets: results, requiredFailure: true };
      }
      continue;
    }

    try {
      const response = await gatewayCall<{ messageId?: string; id?: string; threadId?: string }>({
        method: "send",
        params: {
          to: spec.target.to,
          message: relayText,
          channel: spec.target.channel,
          accountId: spec.target.accountId,
          threadId: spec.target.threadId,
          idempotencyKey: `${params.runContextId}:relay:${params.fromAgent}:${params.toAgent}:${spec.role}:${index}`,
        },
        timeoutMs: 10_000,
      });
      results.push({
        role: spec.role,
        channel: spec.target.channel,
        to: spec.target.to,
        accountId: spec.target.accountId,
        threadId:
          (typeof response?.threadId === "string" ? response.threadId : undefined) ??
          spec.target.threadId,
        status: "sent",
        messageId:
          typeof response?.messageId === "string"
            ? response.messageId
            : typeof response?.id === "string"
              ? response.id
              : undefined,
      });
    } catch (err) {
      const error = formatErrorMessage(err);
      const failed: RelayTargetResult = {
        role: spec.role,
        channel: spec.target.channel,
        to: spec.target.to,
        accountId: spec.target.accountId,
        threadId: spec.target.threadId,
        status: policy.requireDelivery ? "blocked" : "failed",
        error,
      };
      results.push(failed);
      logger.warn("sessions_send relay delivery failed", {
        runId: params.runContextId,
        channel: spec.target.channel,
        to: spec.target.to,
        role: spec.role,
        error,
      });
      if (spec.required && policy.requireDelivery) {
        return { status: "blocked", targets: results, requiredFailure: true };
      }
    }
  }

  const summary = buildRelaySummary({ policy, targets: results });
  return {
    status:
      summary.status === "disabled" || summary.status === "pending"
        ? "not_applicable"
        : summary.status,
    targets: results,
    requiredFailure: false,
  };
}
