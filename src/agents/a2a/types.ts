import type { AnnounceTarget, RelayPolicy } from "../tools/sessions-send-helpers.js";

export type RelayTargetStatus = "sent" | "failed" | "blocked" | "skipped";

export type RelayStatus =
  | "disabled"
  | "not_applicable"
  | "sent"
  | "partial"
  | "failed"
  | "blocked"
  | "pending";

export type RelayMode = "target-only" | "dual-channel";

export type RelayMirrorTurns = "round1" | "all";

export type RelayTargetResult = {
  role: "source" | "target";
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
  status: RelayTargetStatus;
  messageId?: string;
  error?: string;
};

export type RelayResult = {
  status: RelayStatus;
  mode: RelayMode;
  mirrorTurns: RelayMirrorTurns;
  targets: RelayTargetResult[];
};

export type RelayAttemptResult = {
  status: Exclude<RelayStatus, "disabled" | "pending">;
  targets: RelayTargetResult[];
  requiredFailure: boolean;
};

export type RelayTurnParams = {
  runContextId: string;
  relayPolicy?: RelayPolicy;
  sourceRelayTarget?: AnnounceTarget | null;
  targetRelayTarget?: AnnounceTarget | null;
  fromAgent: string;
  toAgent: string;
  text: string;
};

export type RelaySummaryParams = {
  policy?: RelayPolicy;
  targets: RelayTargetResult[];
  blocked?: boolean;
};
