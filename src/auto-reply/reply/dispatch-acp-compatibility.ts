import type { OpenClawConfig } from "../../config/config.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";

function isAcpLikeSessionKey(sessionKey: string): boolean {
  return /(^|:|[-_])acp($|:|[-_])/i.test(sessionKey);
}

export async function hasBoundConversationForSession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  channelRaw: string | undefined;
  accountIdRaw: string | undefined;
}): Promise<boolean> {
  const channel = normalizeOptionalLowercaseString(params.channelRaw) ?? "";
  if (!channel) {
    return false;
  }
  const accountId = normalizeOptionalLowercaseString(params.accountIdRaw) ?? "";
  const channels = params.cfg.channels as Record<string, { defaultAccount?: unknown } | undefined>;
  const configuredDefaultAccountId = channels?.[channel]?.defaultAccount;
  const normalizedAccountId =
    accountId || normalizeOptionalLowercaseString(configuredDefaultAccountId) || "default";
  const { getSessionBindingService } = await import("./dispatch-acp-manager.runtime.js");
  const bindingService = getSessionBindingService();
  const bindings = bindingService.listBySession(params.sessionKey);
  return bindings.some((binding) => {
    const bindingChannel = normalizeOptionalLowercaseString(binding.conversation.channel) ?? "";
    const bindingAccountId = normalizeOptionalLowercaseString(binding.conversation.accountId) ?? "";
    const conversationId = normalizeOptionalString(binding.conversation.conversationId) ?? "";
    return (
      bindingChannel === channel &&
      (bindingAccountId || "default") === normalizedAccountId &&
      conversationId.length > 0
    );
  });
}

export async function shouldAttemptDirectAcpDispatch(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  channelRaw: string | undefined;
  accountIdRaw: string | undefined;
}): Promise<boolean> {
  const sessionKey = normalizeOptionalString(params.sessionKey) ?? "";
  if (!sessionKey) {
    return false;
  }
  if (!sessionKey.includes(":")) {
    return true;
  }
  if (isAcpLikeSessionKey(sessionKey)) {
    return true;
  }
  const { readAcpSessionEntry } = await import("./dispatch-acp-session.runtime.js");
  const entry = readAcpSessionEntry({
    cfg: params.cfg,
    sessionKey,
  }) as { acp?: Record<string, unknown> } | null;
  if (entry?.acp) {
    return true;
  }
  return await hasBoundConversationForSession(params);
}
