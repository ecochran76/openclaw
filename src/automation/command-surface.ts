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
    const duration = durationMatch[1];
    if (duration) {
      parts.push(`--duration ${duration.replace(/\s+/g, "")}`);
    }
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
    const detailRecord = details as Record<string, unknown>;
    const detailText = detailRecord.text;
    if (typeof detailText === "string" && detailText.trim()) {
      return detailText.trim();
    }
    if (typeof detailRecord.error === "string" && detailRecord.error.trim()) {
      return detailRecord.error.trim();
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
    if (!token) {
      continue;
    }
    if (token === "--label" || token === "--model" || token === "--thinking") {
      const value = restTokens[i + 1];
      if (!value || value.startsWith("--")) {
        return { ok: false, errorText: buildAutomationUsageText() };
      }
      i += 1;
      if (token === "--label") {
        label = value;
      } else if (token === "--model") {
        model = value;
      } else {
        thinking = value;
      }
      continue;
    }
    if (token === "--turns" || token === "--tokens" || token === "--duration") {
      if (i + 1 >= restTokens.length) {
        return { ok: false, errorText: buildAutomationUsageText() };
      }
      i += 1;
      const value = restTokens[i];
      if (!value) {
        return { ok: false, errorText: buildAutomationUsageText() };
      }
      if (token === "--turns") {
        if (!/^[1-9]\d*$/.test(value)) {
          return { ok: false, errorText: "🤖 Automation\nBounds must be positive integers." };
        }
        maxTurns = Number(value);
      } else if (token === "--tokens") {
        if (!/^[1-9]\d*$/.test(value)) {
          return { ok: false, errorText: "🤖 Automation\nBounds must be positive integers." };
        }
        maxTokens = Number(value);
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
