import { formatCliCommand } from "../../cli/command-format.js";
import { supportsChatReauthProvider } from "./chat-reauth.js";

export function formatAuthRecoveryHint(params: {
  provider?: string;
  authProfileId?: string;
  allowChatReauth?: boolean;
  includeCliAlternative?: boolean;
}): string {
  const provider = params.provider?.trim();
  const profileId = params.authProfileId?.trim();
  const loginProvider = provider === "openai-codex" ? "openai" : provider;

  if (params.allowChatReauth && supportsChatReauthProvider(provider)) {
    if (profileId) {
      const chatCommand =
        provider === "openai-codex" ? `/reauth --device-code ${profileId}` : `/reauth ${profileId}`;
      const chatHint = `Reply ${chatCommand} in this thread to refresh it here; supported providers will post a device code or chat-safe auth flow`;
      if (params.includeCliAlternative) {
        return `${chatHint}, or run ${formatCliCommand(`openclaw models auth login --provider openai --profile-id ${profileId}`)}.`;
      }
      return `${chatHint}.`;
    }
    return "Reply /reauth <profile-id> in this thread to refresh an OpenAI ChatGPT/Codex profile here.";
  }

  if (loginProvider && profileId) {
    return `Re-authenticate with ${formatCliCommand(`openclaw models auth login --provider ${loginProvider} --profile-id ${profileId}`)} and try again.`;
  }
  if (loginProvider) {
    return `Re-authenticate with ${formatCliCommand(`openclaw models auth login --provider ${loginProvider}`)} and try again.`;
  }
  return "Re-authenticate and try again.";
}
