/** Provider secret input modes: inline plaintext or external secret reference. */
import type { PendingOAuthReauth } from "../config/sessions/types.js";
import type { OAuthCredentials } from "../llm/oauth.js";

export type SecretInputMode = "plaintext" | "ref"; // pragma: allowlist secret

export type ChatReauthCapability = {
  provider: string;
  looksLikeCallbackInput: (input: string) => boolean;
  createPendingAuthorization: (params?: {
    originator?: string;
  }) =>
    | Omit<PendingOAuthReauth, "kind" | "provider" | "profileId">
    | Promise<Omit<PendingOAuthReauth, "kind" | "provider" | "profileId">>;
  completePendingAuthorization: (params: {
    input: string;
    pending: Pick<PendingOAuthReauth, "state" | "verifier" | "redirectUri">;
  }) => Promise<OAuthCredentials>;
  pollPendingAuthorization?: (params: {
    pending: Pick<PendingOAuthReauth, "deviceAuthId" | "userCode" | "intervalMs" | "expiresAt">;
  }) => Promise<OAuthCredentials | null>;
};
