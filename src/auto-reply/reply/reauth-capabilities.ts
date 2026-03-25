import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import type { PendingOAuthReauth } from "../../config/sessions/types.js";
import {
  completeOpenAICodexManualAuthorization,
  createOpenAICodexManualAuthorization,
  looksLikeOpenAICodexCallbackInput,
} from "../../plugins/provider-openai-chatgpt-oauth.js";

export type ChatReauthCapability = {
  provider: string;
  looksLikeCallbackInput: (input: string) => boolean;
  createPendingAuthorization: (params?: {
    originator?: string;
  }) => Omit<PendingOAuthReauth, "kind" | "provider" | "profileId">;
  completePendingAuthorization: (params: {
    input: string;
    pending: Pick<PendingOAuthReauth, "state" | "verifier" | "redirectUri">;
  }) => Promise<OAuthCredentials>;
};

export function getChatReauthCapability(provider: string): ChatReauthCapability | null {
  switch (provider) {
    case "openai":
    case "openai-codex":
      return {
        provider: "openai",
        looksLikeCallbackInput: looksLikeOpenAICodexCallbackInput,
        createPendingAuthorization: (params) =>
          createOpenAICodexManualAuthorization({ originator: params?.originator }),
        completePendingAuthorization: async ({ input, pending }) =>
          await completeOpenAICodexManualAuthorization({
            input,
            state: pending.state,
            verifier: pending.verifier,
            redirectUri: pending.redirectUri,
          }),
      };
    default:
      return null;
  }
}
