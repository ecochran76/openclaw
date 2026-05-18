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
