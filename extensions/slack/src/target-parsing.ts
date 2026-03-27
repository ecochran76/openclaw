// Slack plugin module implements target parsing behavior.
import {
  buildMessagingTarget,
  ensureTargetId,
  parseMentionPrefixOrAtUserTarget,
  requireTargetKind,
  type MessagingTarget,
  type MessagingTargetKind,
  type MessagingTargetParseOptions,
} from "openclaw/plugin-sdk/channel-targets";

export type SlackTargetKind = MessagingTargetKind;

export type SlackTarget = MessagingTarget;

export type SlackTargetParseOptions = MessagingTargetParseOptions;

const SLACK_BARE_ID_PATTERN = /^[CUWGD][A-Z0-9]*\d[A-Z0-9]*$/i;

export function parseSlackTarget(
  raw: string,
  options: SlackTargetParseOptions = {},
): SlackTarget | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const userTarget = parseMentionPrefixOrAtUserTarget({
    raw: trimmed,
    mentionPattern: /^<@([A-Z0-9]+)>$/i,
    prefixes: [
      { prefix: "user:", kind: "user" },
      { prefix: "channel:", kind: "channel" },
      { prefix: "slack:", kind: "user" },
    ],
    atUserPattern: /^[A-Z0-9]+$/i,
    atUserErrorMessage: "Slack DMs require a user id (use user:<id> or <@id>)",
  });
  if (userTarget) {
    return userTarget;
  }
  if (trimmed.startsWith("#")) {
    const candidate = trimmed.slice(1).trim();
    const id = ensureTargetId({
      candidate,
      pattern: /^[A-Z0-9]+$/i,
      errorMessage: "Slack channels require a channel id (use channel:<id>)",
    });
    return buildMessagingTarget("channel", id, trimmed);
  }
  // Bare Slack targets must already be native IDs. Friendly names should be
  // resolved through directory lookup before they reach the explicit parser.
  if (SLACK_BARE_ID_PATTERN.test(trimmed)) {
    return buildMessagingTarget(options.defaultKind ?? "channel", trimmed, trimmed);
  }
  return undefined;
}

export function resolveSlackChannelId(raw: string): string {
  const target = parseSlackTarget(raw, { defaultKind: "channel" });
  return requireTargetKind({ platform: "Slack", target, kind: "channel" });
}

export function normalizeSlackMessagingTarget(raw: string): string | undefined {
  return parseSlackTarget(raw, { defaultKind: "channel" })?.normalized;
}

export function slackTargetsMatch(left: string, right: string): boolean {
  const leftTarget = normalizeSlackMessagingTarget(left);
  const rightTarget = normalizeSlackMessagingTarget(right);
  return Boolean(leftTarget && rightTarget && leftTarget === rightTarget);
}

export function looksLikeSlackTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (/^<@([A-Z0-9]+)>$/i.test(trimmed)) {
    return true;
  }
  if (/^(user|channel):/i.test(trimmed)) {
    return true;
  }
  if (/^slack:/i.test(trimmed)) {
    return true;
  }
  if (/^[@#]/.test(trimmed)) {
    return true;
  }
  return /^[CUWGD][A-Z0-9]{8,}$/i.test(trimmed);
}
