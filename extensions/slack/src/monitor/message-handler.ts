// Slack plugin module implements message handler behavior.
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import { resolveAckReaction } from "openclaw/plugin-sdk/channel-feedback";
import {
  createChannelInboundDebouncer,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import type { ResolvedSlackAccount } from "../accounts.js";
import { reactSlackMessage } from "../actions.js";
import type { SlackSendIdentity } from "../send.js";
import type { SlackMessageEvent } from "../types.js";
import { resolveSlackChannelConfig } from "./channel-config.js";
import { stripSlackMentionsForCommandDetection } from "./commands.js";
import type { SlackMonitorContext } from "./context.js";
import {
  hasSlackInboundMessageDelivery,
  recordSlackInboundMessageDeliveries,
} from "./inbound-delivery-state.js";
import {
  buildSlackDebounceKey,
  buildTopLevelSlackConversationKey,
} from "./message-handler/debounce-key.js";
import { normalizeSlackAckReactionName, toSlackReactionName } from "./message-handler/reactions.js";
import { createSlackThreadTsResolver } from "./thread-resolution.js";

type SlackMessagePipeline = typeof import("./message-handler/pipeline.runtime.js");

let slackMessagePipelinePromise: Promise<SlackMessagePipeline> | undefined;

function loadSlackMessagePipeline(): Promise<SlackMessagePipeline> {
  slackMessagePipelinePromise ??= import("./message-handler/pipeline.runtime.js");
  return slackMessagePipelinePromise;
}

export type SlackMessageHandler = (
  message: SlackMessageEvent,
  opts: {
    source: "message" | "app_mention";
    wasMentioned?: boolean;
    relayIdentity?: SlackSendIdentity;
    /** Wait until any inbound debounce flush and dispatch has completed. */
    awaitDispatch?: boolean;
  },
) => Promise<void>;

type SlackDispatchCompletion = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type QueuedSlackMessageOptions = Parameters<SlackMessageHandler>[1] & {
  dispatchCompletion?: Omit<SlackDispatchCompletion, "promise">;
};

function createSlackDispatchCompletion(): SlackDispatchCompletion {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const APP_MENTION_RETRY_TTL_MS = 60_000;

export class SlackRetryableInboundError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SlackRetryableInboundError";
  }
}

function shouldDebounceSlackMessage(message: SlackMessageEvent, cfg: SlackMonitorContext["cfg"]) {
  const text = message.text ?? "";
  const textForCommandDetection = stripSlackMentionsForCommandDetection(text);
  return shouldDebounceTextInbound({
    text: textForCommandDetection,
    cfg,
    hasMedia: Boolean(message.files && message.files.length > 0),
  });
}

function buildSeenMessageKey(channelId: string | undefined, ts: string | undefined): string | null {
  if (!channelId || !ts) {
    return null;
  }
  return `${channelId}:${ts}`;
}

function shouldAttemptPrePipelineAck(params: {
  ctx: SlackMonitorContext;
  message: SlackMessageEvent;
  opts: { source: "message" | "app_mention"; wasMentioned?: boolean };
}): boolean {
  const { ctx, message, opts } = params;
  if (!message.channel || !message.ts) {
    return false;
  }
  if (!ctx.cfg || typeof ctx.isChannelAllowed !== "function") {
    return false;
  }
  const textMentionsBot =
    Boolean(ctx.botUserId) && typeof message.text === "string"
      ? message.text.includes(`<@${ctx.botUserId}>`)
      : false;
  if (opts.source !== "app_mention" && opts.wasMentioned !== true && !textMentionsBot) {
    return false;
  }
  const scope = ctx.ackReactionScope?.trim().toLowerCase() ?? "";
  if (scope === "off" || scope === "none") {
    return false;
  }
  return ctx.isChannelAllowed({
    channelId: message.channel,
    channelType: message.channel_type,
  });
}

function isSlackDirectConversation(message: SlackMessageEvent): boolean {
  return (
    message.channel_type === "im" ||
    message.channel_type === "mpim" ||
    message.channel.startsWith("D")
  );
}

function isSlackMessageAddressed(params: {
  ctx: SlackMonitorContext;
  message: SlackMessageEvent;
  opts: { source: "message" | "app_mention"; wasMentioned?: boolean };
}): boolean {
  const { ctx, message, opts } = params;
  if (opts.source === "app_mention" || opts.wasMentioned === true) {
    return true;
  }
  return Boolean(ctx.botUserId) && typeof message.text === "string"
    ? message.text.includes(`<@${ctx.botUserId}>`)
    : false;
}

function shouldAttemptPrePipelineTypingReaction(params: {
  ctx: SlackMonitorContext;
  message: SlackMessageEvent;
  opts: { source: "message" | "app_mention"; wasMentioned?: boolean };
}): boolean {
  const { ctx, message, opts } = params;
  if (!message.channel || !message.ts || !ctx.typingReaction) {
    return false;
  }
  if (!ctx.cfg || typeof ctx.isChannelAllowed !== "function") {
    return false;
  }
  if (
    !ctx.isChannelAllowed({
      channelId: message.channel,
      channelType: message.channel_type,
    })
  ) {
    return false;
  }
  if (isSlackMessageAddressed({ ctx, message, opts })) {
    return true;
  }
  if (isSlackDirectConversation(message)) {
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
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  opts: { source: "message" | "app_mention"; wasMentioned?: boolean };
}): boolean {
  const { ctx, account, message, opts } = params;
  if (message.__openclawPrePipelineTypingStarted) {
    return true;
  }
  if (!shouldAttemptPrePipelineTypingReaction({ ctx, message, opts })) {
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
            accountId: account.accountId,
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
    .catch((err) => {
      ctx.logger?.info?.(
        {
          accountId: account.accountId,
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
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  opts: { source: "message" | "app_mention"; wasMentioned?: boolean };
}): boolean {
  const { ctx, account, message, opts } = params;
  if (message.__openclawPrePipelineAckStarted) {
    return true;
  }
  if (!shouldAttemptPrePipelineAck({ ctx, message, opts })) {
    return false;
  }
  const defaultAgentId = resolveDefaultAgentId(ctx.cfg);
  const reaction = normalizeSlackAckReactionName(
    resolveAckReaction(ctx.cfg, defaultAgentId, {
      channel: "slack",
      accountId: account.accountId,
    }),
  );
  if (!reaction) {
    return false;
  }
  const startedAt = Date.now();
  const reactions = [reaction];
  if (
    ctx.typingReaction &&
    !message.__openclawPrePipelineTypingStarted &&
    toSlackReactionName(ctx.typingReaction) !== toSlackReactionName(reaction)
  ) {
    reactions.push(ctx.typingReaction);
  }
  void Promise.all(
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
            accountId: account.accountId,
            channel: message.channel,
            ts: message.ts,
            elapsedMs,
            reactions,
          },
          "slack pre-pipeline ack was slow",
        );
      }
    })
    .catch((err) => {
      ctx.logger?.info?.(
        {
          accountId: account.accountId,
          channel: message.channel,
          ts: message.ts,
          error: formatErrorMessage(err),
        },
        "slack pre-pipeline ack failed",
      );
    });
  message.__openclawPrePipelineAckStarted = true;
  return true;
}

export function createSlackMessageHandler(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  /** Called on each inbound event to update liveness tracking. */
  trackEvent?: () => void;
}): SlackMessageHandler {
  const { ctx, account, trackEvent } = params;
  const { debounceMs, debouncer } = createChannelInboundDebouncer<{
    message: SlackMessageEvent;
    opts: QueuedSlackMessageOptions;
  }>({
    cfg: ctx.cfg,
    channel: "slack",
    buildKey: (entry) => buildSlackDebounceKey(entry.message, ctx.accountId),
    shouldDebounce: (entry) => shouldDebounceSlackMessage(entry.message, ctx.cfg),
    onFlush: async (entries) => {
      const completions = entries
        .map((entry) => entry.opts.dispatchCompletion)
        .filter((completion) => completion !== undefined);
      try {
        await (async () => {
          const last = entries.at(-1);
          if (!last) {
            return;
          }
          const flushedKey = buildSlackDebounceKey(last.message, ctx.accountId);
          const topLevelConversationKey = buildTopLevelSlackConversationKey(
            last.message,
            ctx.accountId,
          );
          if (flushedKey && topLevelConversationKey) {
            const pendingKeys = pendingTopLevelDebounceKeys.get(topLevelConversationKey);
            if (pendingKeys) {
              pendingKeys.delete(flushedKey);
              if (pendingKeys.size === 0) {
                pendingTopLevelDebounceKeys.delete(topLevelConversationKey);
              }
            }
          }
          const combinedText =
            entries.length === 1
              ? (last.message.text ?? "")
              : entries
                  .map((entry) => entry.message.text ?? "")
                  .filter(Boolean)
                  .join("\n");
          const combinedMentioned = entries.some((entry) => Boolean(entry.opts.wasMentioned));
          const syntheticMessage: SlackMessageEvent = {
            ...last.message,
            text: combinedText,
          };
          const seenMessageKey = buildSeenMessageKey(last.message.channel, last.message.ts);
          try {
            const { prepareSlackMessage, dispatchPreparedSlackMessage } =
              await loadSlackMessagePipeline();
            const {
              dispatchCompletion: _completion,
              awaitDispatch: _awaitDispatch,
              ...lastOpts
            } = last.opts;
            const prepared = await prepareSlackMessage({
              ctx,
              account,
              message: syntheticMessage,
              opts: {
                ...lastOpts,
                wasMentioned: combinedMentioned || last.opts.wasMentioned,
              },
            });
            if (!prepared) {
              return;
            }
            if (seenMessageKey) {
              pruneAppMentionRetryKeys(Date.now());
              if (last.opts.source === "app_mention") {
                // If app_mention wins the race and dispatches first, drop the later message dispatch.
                rememberExpiringAppMentionKey(appMentionDispatchedKeys, seenMessageKey);
              } else if (
                last.opts.source === "message" &&
                appMentionDispatchedKeys.has(seenMessageKey)
              ) {
                appMentionDispatchedKeys.delete(seenMessageKey);
                appMentionRetryKeys.delete(seenMessageKey);
                return;
              }
              appMentionRetryKeys.delete(seenMessageKey);
            }
            if (entries.length > 1) {
              const ids = entries.map((entry) => entry.message.ts).filter(Boolean) as string[];
              if (ids.length > 0) {
                prepared.ctxPayload.MessageSids = ids;
                prepared.ctxPayload.MessageSidFirst = ids[0];
                prepared.ctxPayload.MessageSidLast = ids[ids.length - 1];
              }
            }
            try {
              await dispatchPreparedSlackMessage(prepared);
              await recordSlackInboundMessageDeliveries({
                accountId: ctx.accountId,
                messages: entries.map((entry) => entry.message),
              });
            } catch (error) {
              if (!(error instanceof SlackRetryableInboundError)) {
                await recordSlackInboundMessageDeliveries({
                  accountId: ctx.accountId,
                  messages: entries.map((entry) => entry.message),
                });
              }
              throw error;
            }
          } catch (error) {
            if (error instanceof SlackRetryableInboundError) {
              if (seenMessageKey) {
                appMentionDispatchedKeys.delete(seenMessageKey);
              }
              ctx.releaseSeenMessage(last.message.channel, last.message.ts);
            }
            throw error;
          }
        })();
        for (const completion of completions) {
          completion.resolve();
        }
      } catch (error) {
        for (const completion of completions) {
          completion.reject(error);
        }
        throw error;
      }
    },
    onError: (err) => {
      ctx.runtime.error?.(`slack inbound debounce flush failed: ${formatErrorMessage(err)}`);
    },
  });
  const threadTsResolver = createSlackThreadTsResolver({ client: ctx.app.client });
  const pendingTopLevelDebounceKeys = new Map<string, Set<string>>();
  const appMentionRetryKeys = new Map<string, number>();
  const appMentionDispatchedKeys = new Map<string, number>();

  const pruneAppMentionRetryKeys = (rawNow: number): boolean => {
    const now = asDateTimestampMs(rawNow);
    if (now === undefined) {
      appMentionRetryKeys.clear();
      appMentionDispatchedKeys.clear();
      return false;
    }
    for (const [key, expiresAt] of appMentionRetryKeys) {
      if (asDateTimestampMs(expiresAt) === undefined || expiresAt <= now) {
        appMentionRetryKeys.delete(key);
      }
    }
    for (const [key, expiresAt] of appMentionDispatchedKeys) {
      if (asDateTimestampMs(expiresAt) === undefined || expiresAt <= now) {
        appMentionDispatchedKeys.delete(key);
      }
    }
    return true;
  };

  const rememberExpiringAppMentionKey = (map: Map<string, number>, key: string): void => {
    const now = Date.now();
    if (!pruneAppMentionRetryKeys(now)) {
      return;
    }
    const expiresAt = resolveExpiresAtMsFromDurationMs(APP_MENTION_RETRY_TTL_MS, { nowMs: now });
    if (expiresAt !== undefined) {
      map.set(key, expiresAt);
    }
  };

  const rememberAppMentionRetryKey = (key: string) => {
    rememberExpiringAppMentionKey(appMentionRetryKeys, key);
  };

  const consumeAppMentionRetryKey = (key: string) => {
    const now = Date.now();
    if (!pruneAppMentionRetryKeys(now)) {
      return false;
    }
    if (!appMentionRetryKeys.has(key)) {
      return false;
    }
    appMentionRetryKeys.delete(key);
    return true;
  };

  return async (message, opts) => {
    if (opts.source === "message" && message.type !== "message") {
      return;
    }
    if (
      opts.source === "message" &&
      message.subtype &&
      message.subtype !== "file_share" &&
      message.subtype !== "bot_message" &&
      message.subtype !== "thread_broadcast"
    ) {
      return;
    }
    const seenMessageKey = buildSeenMessageKey(message.channel, message.ts);
    if (
      seenMessageKey &&
      (await hasSlackInboundMessageDelivery({
        accountId: ctx.accountId,
        channelId: message.channel,
        ts: message.ts,
      }))
    ) {
      return;
    }
    const wasSeen = seenMessageKey ? ctx.markMessageSeen(message.channel, message.ts) : false;
    if (seenMessageKey && opts.source === "message" && !wasSeen) {
      // Prime exactly one fallback app_mention allowance immediately so a near-simultaneous
      // app_mention is not dropped while message handling is still in-flight.
      rememberAppMentionRetryKey(seenMessageKey);
    }
    if (seenMessageKey && wasSeen) {
      // Allow exactly one app_mention retry if the same ts was previously dropped
      // from the message stream before it reached dispatch.
      if (opts.source !== "app_mention" || !consumeAppMentionRetryKey(seenMessageKey)) {
        return;
      }
    }
    trackEvent?.();
    startPrePipelineTypingReaction({ ctx, account, message, opts });
    const prePipelineAckStarted = startPrePipelineAck({ ctx, account, message, opts });
    const resolvedMessage = await threadTsResolver.resolve({ message, source: opts.source });
    if (prePipelineAckStarted) {
      resolvedMessage.__openclawPrePipelineAckStarted = true;
    }
    const debounceKey = buildSlackDebounceKey(resolvedMessage, ctx.accountId);
    const conversationKey = buildTopLevelSlackConversationKey(resolvedMessage, ctx.accountId);
    const canDebounce = debounceMs > 0 && shouldDebounceSlackMessage(resolvedMessage, ctx.cfg);
    if (!canDebounce && conversationKey) {
      const pendingKeys = pendingTopLevelDebounceKeys.get(conversationKey);
      if (pendingKeys && pendingKeys.size > 0) {
        const keysToFlush = Array.from(pendingKeys);
        for (const pendingKey of keysToFlush) {
          await debouncer.flushKey(pendingKey);
        }
      }
    }
    if (canDebounce && debounceKey && conversationKey) {
      const pendingKeys = pendingTopLevelDebounceKeys.get(conversationKey) ?? new Set<string>();
      pendingKeys.add(debounceKey);
      pendingTopLevelDebounceKeys.set(conversationKey, pendingKeys);
    }
    const dispatchCompletion = opts.awaitDispatch ? createSlackDispatchCompletion() : undefined;
    await debouncer.enqueue({
      message: resolvedMessage,
      opts: {
        ...opts,
        ...(dispatchCompletion
          ? {
              dispatchCompletion: {
                resolve: dispatchCompletion.resolve,
                reject: dispatchCompletion.reject,
              },
            }
          : {}),
      },
    });
    await dispatchCompletion?.promise;
  };
}
