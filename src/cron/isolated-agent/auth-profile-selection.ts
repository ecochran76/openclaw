import type { ResolvedSessionAuthProfileSelection } from "../../agents/auth-profiles/session-override.js";

export type CronAuthProfileSelectionResult =
  | {
      blocked: true;
      error: string;
      logMessage: string;
    }
  | {
      blocked: false;
      authProfileId?: ResolvedSessionAuthProfileSelection["profileId"];
      authProfileIdSource?: ResolvedSessionAuthProfileSelection["source"];
      logMessage?: string;
    };

export function resolveCronAuthProfileSelectionResult(
  authProfile: ResolvedSessionAuthProfileSelection,
): CronAuthProfileSelectionResult {
  if (authProfile.blockedReason) {
    return {
      blocked: true,
      error: authProfile.blockedReason.message,
      logMessage: authProfile.blockedReason.message,
    };
  }
  return {
    blocked: false,
    authProfileId: authProfile.profileId,
    authProfileIdSource: authProfile.source,
    logMessage: authProfile.switchNotice?.message,
  };
}
