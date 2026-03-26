import { formatCliCommand } from "../../cli/command-format.js";

export function formatAuthRecoveryHint(params: {
  provider?: string;
  authProfileId?: string;
  allowChatReauth?: boolean;
  includeCliAlternative?: boolean;
}): string {
  const provider = params.provider?.trim();
  const profileId = params.authProfileId?.trim();
  const loginProvider = provider === "openai-codex" ? "openai" : provider;
  const supportsChatReauth =
    params.allowChatReauth && (provider === "openai" || provider === "openai-codex");

  if (supportsChatReauth) {
    if (profileId) {
      const chatHint = `Reply /reauth ${profileId} in this thread to refresh it here`;
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
