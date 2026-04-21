import { collectTextContentBlocks } from "../agents/content-blocks.js";
import { parseDurationMs } from "../cli/parse-duration.js";

export const AUTOMATION_COMMAND = "/automation";

export function buildAutomationUsageText(): string {
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

export function buildSuggestedAutomationCommand(text: string): string | null {
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

export function buildAutomationCommandSuggestionReply(command: string): string {
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

export function sliceAutomationCommandTail(commandBodyNormalized: string): string | null {
  if (commandBodyNormalized === AUTOMATION_COMMAND) {
    return "";
  }
  if (commandBodyNormalized.startsWith(`${AUTOMATION_COMMAND}:`)) {
    return commandBodyNormalized.slice(AUTOMATION_COMMAND.length + 1).trim();
  }
  if (commandBodyNormalized.startsWith(`${AUTOMATION_COMMAND} `)) {
    return commandBodyNormalized.slice(AUTOMATION_COMMAND.length).trim();
  }
  return null;
}

export function extractAutomationToolText(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "✅ Done.";
  }
  const details = (result as { details?: unknown }).details;
  if (details && typeof details === "object") {
    const detailText = (details as Record<string, unknown>).text;
    if (typeof detailText === "string" && detailText.trim()) {
      return detailText.trim();
    }
  }
  const content = (result as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.trim() || "✅ Done.";
  }
  const joined = collectTextContentBlocks(content).join("").trim();
  return joined || "✅ Done.";
}

export function buildAcceptedAutomationRunReply(params: {
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

export type ParsedAutomationRunArgs =
  | {
      ok: true;
      goal: string;
      label?: string;
      model?: string;
      thinking?: string;
      maxTurns?: number;
      maxTokens?: number;
      maxDurationSeconds?: number;
    }
  | {
      ok: false;
      errorText: string;
    };

export function parseAutomationRunArgs(restTokens: string[]): ParsedAutomationRunArgs {
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
          return { ok: false, errorText: `🤖 Automation\nInvalid duration: ${value}` };
        }
      }
      continue;
    }
    goalParts.push(token);
  }

  const goal = goalParts.join(" ").trim();
  if (!goal) {
    return { ok: false, errorText: buildAutomationUsageText() };
  }
  if (
    (maxTurns !== undefined && (!Number.isFinite(maxTurns) || maxTurns < 1)) ||
    (maxTokens !== undefined && (!Number.isFinite(maxTokens) || maxTokens < 1))
  ) {
    return { ok: false, errorText: "🤖 Automation\nBounds must be positive integers." };
  }

  return {
    ok: true,
    goal,
    label,
    model,
    thinking,
    maxTurns,
    maxTokens,
    maxDurationSeconds,
  };
}
