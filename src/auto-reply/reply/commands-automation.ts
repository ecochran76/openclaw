import { collectTextContentBlocks } from "../../agents/content-blocks.js";
import { createAutomationTool } from "../../agents/tools/automation-tool.js";
import { resolveAutomationStopSpec } from "../../automation/config.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { logVerbose } from "../../globals.js";
import { resolveGatewayMessageChannel } from "../../utils/message-channel.js";
import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";

const COMMAND = "/automation";
const ACTIONS = new Set(["run", "list", "status", "steer", "stop", "help"]);

function stopWithText(text: string): CommandHandlerResult {
  return { shouldContinue: false, reply: { text } };
}

function buildUsageText(): string {
  return [
    "🤖 Automation",
    "- /automation run <goal> [--label <label>] [--model <model>] [--thinking <level>] [--turns N] [--tokens N] [--duration 30m]",
    "- /automation list",
    "- /automation status [id|#]",
    "- /automation steer <id|#> <message>",
    "- /automation stop [id|#]",
  ].join("\n");
}

function normalizeSuggestedGoal(raw: string): string {
  return raw
    .replace(/(?:^|[\s,;])(?:--turns?|max\s+\d+\s+turns?)\b[\s,;]*/gi, " ")
    .replace(/(?:^|[\s,;])(?:--tokens?|max\s+\d+\s+tokens?)\b[\s,;]*/gi, " ")
    .replace(/(?:^|[\s,;])(?:--duration\s+\S+|for\s+\d+\s*(?:s|m|h|d|w)\b)/gi, " ")
    .replace(/^[\s,.:;-]+/, "")
    .replace(/^(?:run\b\s*)/i, "")
    .replace(/^(?:that\s+will|which\s+will|to|for)\s+/i, "")
    .replace(/[.,;:\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSuggestedAutomationCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/")) {
    return null;
  }
  if (!/\/automation\b/i.test(trimmed)) {
    return null;
  }
  if (!/\b(?:set\s*up|setup|start|launch|create|kick\s*off|begin)\b/i.test(trimmed)) {
    return null;
  }

  const afterAutomation = trimmed.split(/\/automation\b/i)[1]?.trim() ?? "";
  const maxTurnsMatch = afterAutomation.match(/(?:^|[\s,;])max\s+(\d+)\s+turns?\b/i);
  const maxTokensMatch = afterAutomation.match(/(?:^|[\s,;])max\s+(\d+)\s+tokens?\b/i);
  const durationMatch = afterAutomation.match(/(?:^|[\s,;])for\s+(\d+\s*(?:s|m|h|d|w))\b/i);
  const goal = normalizeSuggestedGoal(afterAutomation);
  if (!goal) {
    return null;
  }

  const parts = [`/automation run ${goal}`];
  if (maxTurnsMatch) {
    parts.push(`--turns ${maxTurnsMatch[1]}`);
  }
  if (maxTokensMatch) {
    parts.push(`--tokens ${maxTokensMatch[1]}`);
  }
  if (durationMatch) {
    parts.push(`--duration ${durationMatch[1].replace(/\s+/g, "")}`);
  }
  return parts.join(" ");
}

function buildAutomationCommandSuggestionReply(command: string): string {
  return [
    "🤖 Automation",
    "To use the built-in automation command, start the message with the command itself.",
    "",
    "Suggested command:",
    `\`${command}\``,
  ].join("\n");
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}k`;
  }
  return `${value}`;
}

function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

function sliceCommandTail(commandBodyNormalized: string): string | null {
  if (commandBodyNormalized === COMMAND) {
    return "";
  }
  if (commandBodyNormalized.startsWith(`${COMMAND}:`)) {
    return commandBodyNormalized.slice(COMMAND.length + 1).trim();
  }
  if (commandBodyNormalized.startsWith(`${COMMAND} `)) {
    return commandBodyNormalized.slice(COMMAND.length).trim();
  }
  return null;
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

function extractToolText(result: unknown): string {
  const detailText = readDetailString(result, "text");
  if (detailText) {
    return detailText;
  }
  if (!result || typeof result !== "object") {
    return "✅ Done.";
  }
  const content = (result as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.trim() || "✅ Done.";
  }
  const joined = collectTextContentBlocks(content).join("").trim();
  return joined || "✅ Done.";
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

function buildAcceptedRunReply(params: {
  runId?: string;
  goal: string;
  label?: string;
  maxTurns?: number;
  maxTokens?: number;
  maxDurationSeconds?: number;
}) {
  const label = params.label?.trim();
  const runLabel = label
    ? `${params.runId ?? "(pending)"} (${label})`
    : (params.runId ?? "(pending)");
  return [
    "🤖 Automation started",
    `Run: ${runLabel}`,
    `Goal: ${params.goal}`,
    `Bounds: turns ${params.maxTurns} · tokens ${formatTokens(params.maxTokens ?? 0)} · duration ${formatDuration(params.maxDurationSeconds ?? 0)}`,
    "Mode: isolated · deterministic",
    "Use /automation status to inspect it or /automation stop to halt it.",
  ].join("\n");
}

export const handleAutomationCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const rest = sliceCommandTail(params.command.commandBodyNormalized);
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
    return stopWithText(buildUsageText());
  }

  const tool = createCommandAutomationTool(params);
  const toolCallId = `cmd_automation_${Date.now()}`;

  if (action === "help") {
    return stopWithText(buildUsageText());
  }

  if (action === "list") {
    const result = await tool.execute(toolCallId, { action: "list" });
    return stopWithText(extractToolText(result));
  }

  if (action === "run") {
    const goalParts: string[] = [];
    let label: string | undefined;
    let model: string | undefined;
    let thinking: string | undefined;
    let maxTurns: number | undefined;
    let maxTokens: number | undefined;
    let maxDurationSeconds: number | undefined;

    for (let i = 1; i < restTokens.length; i += 1) {
      const token = restTokens[i];
      if (
        (token === "--label" || token === "--model" || token === "--thinking") &&
        i + 1 < restTokens.length
      ) {
        i += 1;
        if (token === "--label") {
          label = restTokens[i];
        } else if (token === "--model") {
          model = restTokens[i];
        } else {
          thinking = restTokens[i];
        }
        continue;
      }
      if (
        (token === "--turns" || token === "--tokens" || token === "--duration") &&
        i + 1 < restTokens.length
      ) {
        i += 1;
        const value = restTokens[i];
        if (token === "--turns") {
          maxTurns = Number.parseInt(value, 10);
        } else if (token === "--tokens") {
          maxTokens = Number.parseInt(value, 10);
        } else {
          try {
            maxDurationSeconds = Math.max(
              1,
              Math.ceil(parseDurationMs(value, { defaultUnit: "s" }) / 1000),
            );
          } catch {
            return stopWithText(`🤖 Automation\nInvalid duration: ${value}`);
          }
        }
        continue;
      }
      goalParts.push(token);
    }

    const goal = goalParts.join(" ").trim();
    if (!goal) {
      return stopWithText(buildUsageText());
    }
    if (
      (maxTurns !== undefined && (!Number.isFinite(maxTurns) || maxTurns < 1)) ||
      (maxTokens !== undefined && (!Number.isFinite(maxTokens) || maxTokens < 1))
    ) {
      return stopWithText("🤖 Automation\nBounds must be positive integers.");
    }

    const resolvedStop = resolveAutomationStopSpec(
      {
        maxTurns,
        maxTokens,
        maxDurationSeconds,
      },
      params.cfg,
    );
    const result = await tool.execute(toolCallId, {
      action: "run",
      goal,
      label,
      model,
      thinking,
      maxTurns,
      maxTokens,
      maxDurationSeconds,
    });
    const runId = readDetailString(result, "runId");
    return stopWithText(
      buildAcceptedRunReply({
        runId,
        goal,
        label,
        maxTurns: resolvedStop.maxTurns,
        maxTokens: resolvedStop.maxTokens,
        maxDurationSeconds: resolvedStop.maxDurationSeconds,
      }),
    );
  }

  if (action === "status" || action === "stop") {
    const selector = restTokens[1];
    const result = await tool.execute(toolCallId, selector ? { action, selector } : { action });
    return stopWithText(extractToolText(result));
  }

  if (action === "steer") {
    const selector = restTokens[1];
    const message = restTokens.slice(2).join(" ").trim();
    if (!selector || !message) {
      return stopWithText(buildUsageText());
    }
    const result = await tool.execute(toolCallId, { action: "steer", selector, message });
    return stopWithText(extractToolText(result));
  }

  return stopWithText(buildUsageText());
};
