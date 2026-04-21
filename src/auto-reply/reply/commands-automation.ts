import { createAutomationTool } from "../../agents/tools/automation-tool.js";
import {
  buildAcceptedAutomationRunReply,
  buildAutomationCommandSuggestionReply,
  buildAutomationUsageText,
  buildSuggestedAutomationCommand,
  extractAutomationToolText,
  parseAutomationRunArgs,
  sliceAutomationCommandTail,
} from "../../automation/command-surface.js";
import { resolveAutomationStopSpec } from "../../automation/config.js";
import { logVerbose } from "../../globals.js";
import { resolveGatewayMessageChannel } from "../../utils/message-channel.js";
import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";

const ACTIONS = new Set(["run", "list", "status", "steer", "stop", "help"]);

function stopWithText(text: string): CommandHandlerResult {
  return { shouldContinue: false, reply: { text } };
}

function readDetailString(result: unknown, key: string): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const value = (details as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function createCommandAutomationTool(
  params: Parameters<CommandHandler>[0],
): ReturnType<typeof createAutomationTool> {
  const commandTo = typeof params.command.to === "string" ? params.command.to.trim() : "";
  const originatingTo =
    typeof params.ctx.OriginatingTo === "string" ? params.ctx.OriginatingTo.trim() : "";
  const fallbackTo = typeof params.ctx.To === "string" ? params.ctx.To.trim() : "";
  const normalizedTo = originatingTo || commandTo || fallbackTo || undefined;
  const channel =
    resolveGatewayMessageChannel(params.ctx.OriginatingChannel) ??
    resolveGatewayMessageChannel(params.command.channel) ??
    resolveGatewayMessageChannel(params.ctx.Surface) ??
    resolveGatewayMessageChannel(params.ctx.Provider) ??
    undefined;
  return createAutomationTool({
    agentSessionKey: params.sessionKey,
    agentChannel: channel,
    agentAccountId: params.ctx.AccountId,
    agentTo: normalizedTo,
    agentThreadId: params.ctx.MessageThreadId,
    currentChannelId: params.ctx.NativeChannelId,
    currentThreadTs:
      params.ctx.MessageThreadId != null ? String(params.ctx.MessageThreadId) : undefined,
    config: params.cfg,
  });
}

export const handleAutomationCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const rest = sliceAutomationCommandTail(params.command.commandBodyNormalized);
  if (rest === null) {
    const suggestedCommand = buildSuggestedAutomationCommand(params.command.commandBodyNormalized);
    if (suggestedCommand) {
      return stopWithText(buildAutomationCommandSuggestionReply(suggestedCommand));
    }
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /automation from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const restTokens = rest.split(/\s+/).filter(Boolean);
  const action = restTokens[0]?.toLowerCase() ?? "help";
  if (!ACTIONS.has(action)) {
    return stopWithText(buildAutomationUsageText());
  }

  const tool = createCommandAutomationTool(params);
  const toolCallId = `cmd_automation_${Date.now()}`;

  if (action === "help") {
    return stopWithText(buildAutomationUsageText());
  }

  if (action === "list") {
    const result = await tool.execute(toolCallId, { action: "list" });
    return stopWithText(extractAutomationToolText(result));
  }

  if (action === "run") {
    const parsed = parseAutomationRunArgs(restTokens);
    if (!parsed.ok) {
      return stopWithText(parsed.errorText);
    }

    const resolvedStop = resolveAutomationStopSpec(
      {
        maxTurns: parsed.maxTurns,
        maxTokens: parsed.maxTokens,
        maxDurationSeconds: parsed.maxDurationSeconds,
      },
      params.cfg,
    );
    const result = await tool.execute(toolCallId, {
      action: "run",
      goal: parsed.goal,
      label: parsed.label,
      model: parsed.model,
      thinking: parsed.thinking,
      maxTurns: parsed.maxTurns,
      maxTokens: parsed.maxTokens,
      maxDurationSeconds: parsed.maxDurationSeconds,
    });
    const runId = readDetailString(result, "runId");
    return stopWithText(
      buildAcceptedAutomationRunReply({
        runId,
        goal: parsed.goal,
        label: parsed.label,
        maxTurns: resolvedStop.maxTurns,
        maxTokens: resolvedStop.maxTokens,
        maxDurationSeconds: resolvedStop.maxDurationSeconds,
      }),
    );
  }

  if (action === "status" || action === "stop") {
    const selector = restTokens[1];
    const result = await tool.execute(toolCallId, selector ? { action, selector } : { action });
    return stopWithText(extractAutomationToolText(result));
  }

  if (action === "steer") {
    const selector = restTokens[1];
    const message = restTokens.slice(2).join(" ").trim();
    if (!selector || !message) {
      return stopWithText(buildAutomationUsageText());
    }
    const result = await tool.execute(toolCallId, { action: "steer", selector, message });
    return stopWithText(extractAutomationToolText(result));
  }

  return stopWithText(buildAutomationUsageText());
};
