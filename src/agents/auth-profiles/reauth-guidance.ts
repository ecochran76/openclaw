import { formatCliCommand } from "../../cli/command-format.js";

export function formatAuthRecoveryHint(params: {
  provider?: string;
  authProfileId?: string;
}): string {
  const provider = params.provider?.trim();
  const profileId = params.authProfileId?.trim();
  const loginProvider = provider === "openai-codex" ? "openai" : provider;

  if (loginProvider && profileId) {
    return `Re-authenticate with ${formatCliCommand(`openclaw models auth login --provider ${loginProvider} --profile-id ${profileId}`)} and try again.`;
  }
  if (loginProvider) {
    return `Re-authenticate with ${formatCliCommand(`openclaw models auth login --provider ${loginProvider}`)} and try again.`;
  }
  return "Re-authenticate and try again.";
}
