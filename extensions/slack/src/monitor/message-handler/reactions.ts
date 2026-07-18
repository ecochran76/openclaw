import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import { resolveAckReaction } from "openclaw/plugin-sdk/channel-feedback";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { reactSlackMessage, removeSlackReaction } from "../../actions.js";
import type { SlackMessageEvent } from "../../types.js";
import { resolveSlackChannelConfig } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";

// Slack reactions.add/remove expect shortcode names, not raw unicode emoji.
export const SLACK_UNICODE_REACTION_NAMES: Record<string, string> = {
  "👀": "eyes",
  "🤔": "thinking_face",
  "🔥": "fire",
  "👨‍💻": "male-technologist",
  "👨💻": "male-technologist",
  "👩‍💻": "female-technologist",
  "⚡": "zap",
  "🌐": "globe_with_meridians",
  "✅": "white_check_mark",
  "👍": "thumbsup",
  "❌": "x",
  "😱": "scream",
  "🥱": "yawning_face",
  "😨": "fearful",
  "⏳": "hourglass_flowing_sand",
  "⚠️": "warning",
  "✍": "writing_hand",
  "🗜️": "compression",
  "🗜": "compression",
  "🧠": "brain",
  "🛠️": "hammer_and_wrench",
  "🛠": "hammer_and_wrench",
  "💻": "computer",
};

const SLACK_REACTION_NAME_RE = /^(?:[a-z0-9][a-z0-9_+-]*|\+1|-1)$/;
const DEFAULT_SLACK_ACK_REACTION = "eyes";

export function toSlackReactionName(emoji: string): string {
  let trimmed = emoji.trim();
  while (trimmed.startsWith(":")) {
    trimmed = trimmed.slice(1);
  }
  while (trimmed.endsWith(":")) {
    trimmed = trimmed.slice(0, -1);
  }
  return SLACK_UNICODE_REACTION_NAMES[trimmed] ?? trimmed;
}

export function isSlackReactionName(name: string): boolean {
  return SLACK_REACTION_NAME_RE.test(name.trim());
}

export function normalizeSlackAckReactionName(emoji: string | undefined): string {
  if (!emoji?.trim()) {
    return "";
  }
  const name = toSlackReactionName(emoji);
  return isSlackReactionName(name) ? name : DEFAULT_SLACK_ACK_REACTION;
}

type SlackFeedbackSource = "message" | "app_mention" | "history_reconcile";

function isSlackMessageAddressed(params: {
  ctx: SlackMonitorContext;
  message: SlackMessageEvent;
  opts: { source: SlackFeedbackSource; wasMentioned?: boolean };
}): boolean {
  const { ctx, message, opts } = params;
  if (opts.source === "app_mention" || opts.wasMentioned === true) {
    return true;
  }
  return Boolean(ctx.botUserId) && typeof message.text === "string"
    ? message.text.includes(`<@${ctx.botUserId}>`)
    : false;
}

function isSlackDirectConversation(message: SlackMessageEvent): boolean {
  return (
    message.channel_type === "im" ||
    message.channel_type === "mpim" ||
    message.channel.startsWith("D")
  );
}

function isAllowedSlackReactionTarget(params: {
  ctx: SlackMonitorContext;
  message: SlackMessageEvent;
}): boolean {
  const { ctx, message } = params;
  return Boolean(
    message.channel &&
    message.ts &&
    ctx.cfg &&
    typeof ctx.isChannelAllowed === "function" &&
    ctx.isChannelAllowed({
      channelId: message.channel,
      channelType: message.channel_type,
    }),
  );
}

function shouldStartEarlyTypingReaction(params: {
  ctx: SlackMonitorContext;
  message: SlackMessageEvent;
  opts: { source: SlackFeedbackSource; wasMentioned?: boolean };
}): boolean {
  const { ctx, message, opts } = params;
  if (!ctx.typingReaction || !isAllowedSlackReactionTarget({ ctx, message })) {
    return false;
  }
  if (isSlackMessageAddressed({ ctx, message, opts }) || isSlackDirectConversation(message)) {
    return true;
  }
  const channelConfig = resolveSlackChannelConfig({
    channelId: message.channel,
    channels: ctx.channelsConfig,
    channelKeys: ctx.channelsConfigKeys,
    defaultRequireMention: ctx.defaultRequireMention,
    allowNameMatching: ctx.allowNameMatching,
  });
  return channelConfig?.allowed === true && !channelConfig.requireMention;
}

export function startPrePipelineTypingReaction(params: {
  ctx: SlackMonitorContext;
  accountId: string;
  message: SlackMessageEvent;
  opts: { source: SlackFeedbackSource; wasMentioned?: boolean };
}): boolean {
  const { ctx, accountId, message, opts } = params;
  if (message.__openclawPrePipelineTypingStarted) {
    return true;
  }
  if (!shouldStartEarlyTypingReaction({ ctx, message, opts })) {
    return false;
  }
  const startedAt = Date.now();
  const typingPromise = reactSlackMessage(message.channel, message.ts ?? "", ctx.typingReaction, {
    token: ctx.botToken,
    client: ctx.app.client,
  })
    .then(() => {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= 1000) {
        ctx.logger?.info?.(
          {
            accountId,
            channel: message.channel,
            ts: message.ts,
            elapsedMs,
            reaction: ctx.typingReaction,
          },
          "slack pre-pipeline typing reaction was slow",
        );
      }
      return true;
    })
    .catch((err: unknown) => {
      ctx.logger?.info?.(
        {
          accountId,
          channel: message.channel,
          ts: message.ts,
          error: formatErrorMessage(err),
        },
        "slack pre-pipeline typing reaction failed",
      );
      return false;
    });
  message.__openclawPrePipelineTypingStarted = true;
  message.__openclawPrePipelineTypingPromise = typingPromise;
  return true;
}

export function startPrePipelineAck(params: {
  ctx: SlackMonitorContext;
  accountId: string;
  message: SlackMessageEvent;
  opts: { source: SlackFeedbackSource; wasMentioned?: boolean };
}): boolean {
  const { ctx, accountId, message, opts } = params;
  if (message.__openclawPrePipelineAckStarted) {
    return true;
  }
  if (
    !isAllowedSlackReactionTarget({ ctx, message }) ||
    !isSlackMessageAddressed({ ctx, message, opts })
  ) {
    return false;
  }
  const scope = ctx.ackReactionScope?.trim().toLowerCase() ?? "";
  if (scope === "off" || scope === "none") {
    return false;
  }
  const defaultAgentId = resolveDefaultAgentId(ctx.cfg);
  const reaction = normalizeSlackAckReactionName(
    resolveAckReaction(ctx.cfg, defaultAgentId, {
      channel: "slack",
      accountId,
    }),
  );
  if (!reaction) {
    return false;
  }
  const reactions = [reaction];
  if (
    ctx.typingReaction &&
    !message.__openclawPrePipelineTypingStarted &&
    toSlackReactionName(ctx.typingReaction) !== toSlackReactionName(reaction)
  ) {
    reactions.push(ctx.typingReaction);
  }
  const startedAt = Date.now();
  const ackPromise = Promise.all(
    reactions.map((emoji) =>
      reactSlackMessage(message.channel, message.ts ?? "", emoji, {
        token: ctx.botToken,
        client: ctx.app.client,
      }),
    ),
  )
    .then(() => {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= 1000) {
        ctx.logger?.info?.(
          {
            accountId,
            channel: message.channel,
            ts: message.ts,
            elapsedMs,
            reactions,
          },
          "slack pre-pipeline ack was slow",
        );
      }
      return true;
    })
    .catch((err: unknown) => {
      ctx.logger?.info?.(
        {
          accountId,
          channel: message.channel,
          ts: message.ts,
          error: formatErrorMessage(err),
        },
        "slack pre-pipeline ack failed",
      );
      return false;
    });
  void ackPromise;
  message.__openclawPrePipelineAckStarted = true;
  message.__openclawPrePipelineAckPromise = ackPromise;
  return true;
}

export async function clearPrePipelineReactions(params: {
  ctx: SlackMonitorContext;
  accountId: string;
  message: SlackMessageEvent;
}): Promise<void> {
  const { ctx, accountId, message } = params;
  const reactions = new Set<string>();
  if (message.__openclawPrePipelineAckStarted) {
    const defaultAgentId = resolveDefaultAgentId(ctx.cfg);
    const ackReaction = normalizeSlackAckReactionName(
      resolveAckReaction(ctx.cfg, defaultAgentId, {
        channel: "slack",
        accountId,
      }),
    );
    if (ackReaction) {
      reactions.add(ackReaction);
    }
  }
  if (message.__openclawPrePipelineTypingStarted && ctx.typingReaction) {
    reactions.add(ctx.typingReaction);
  } else if (
    message.__openclawPrePipelineAckStarted &&
    ctx.typingReaction &&
    [...reactions].every(
      (reaction) => toSlackReactionName(reaction) !== toSlackReactionName(ctx.typingReaction),
    )
  ) {
    // Ack startup also adds the typing reaction when the earlier typing gate did
    // not start it. Reconstruct that exact set so a rejected message leaves none.
    reactions.add(ctx.typingReaction);
  }
  await Promise.all([
    message.__openclawPrePipelineAckPromise?.catch(() => false),
    message.__openclawPrePipelineTypingPromise?.catch(() => false),
  ]);
  await Promise.all(
    [...reactions].map((emoji) =>
      removeSlackReaction(message.channel, message.ts ?? "", emoji, {
        token: ctx.botToken,
        client: ctx.app.client,
      }).catch((err: unknown) => {
        if (!formatErrorMessage(err).includes("no_reaction")) {
          ctx.logger?.info?.(
            {
              accountId,
              channel: message.channel,
              ts: message.ts,
              reaction: emoji,
              error: formatErrorMessage(err),
            },
            "slack rejected-message reaction cleanup failed",
          );
        }
      }),
    ),
  );
  message.__openclawPrePipelineAckStarted = false;
  message.__openclawPrePipelineAckPromise = undefined;
  message.__openclawPrePipelineTypingStarted = false;
  message.__openclawPrePipelineTypingPromise = undefined;
}
