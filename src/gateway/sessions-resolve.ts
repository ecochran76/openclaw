// Gateway sessions.resolve implementation helper.
// Resolves key/sessionId/label selectors into one canonical session key.
import {
  normalizeAgentId,
  normalizeOptionalAccountId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
  type SessionsResolveParams,
} from "../../packages/gateway-protocol/src/index.js";
import { canonicalizeSessionEntryAliases, type SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionIdMatchSelection } from "../sessions/session-id-resolution.js";
import { parseSessionLabel } from "../sessions/session-label.js";
import {
  filterAndSortSessionEntries,
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  resolveDeletedAgentIdFromSessionKey,
  resolveGatewaySessionStoreTargetWithStore,
} from "./session-utils.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

type ResolveSearchField =
  | "key"
  | "sessionId"
  | "label"
  | "displayName"
  | "subject"
  | "derivedTitle"
  | "lastMessage";

type ResolveSelection = "most-recent" | "least-recent";
type ResolveThreadPolicy = "exact" | "prefer-thread" | "most-recent" | "channel-root";
type ResolveMatchedBy = "key" | "sessionId" | "label" | "delivery-target" | "search" | "selector";

const DEFAULT_SEARCH_FIELDS: ResolveSearchField[] = [
  "displayName",
  "label",
  "subject",
  "sessionId",
  "key",
];

export type SessionsResolveResult =
  | {
      ok: true;
      key: string;
      agentId?: string;
      deliveryContext?: {
        channel?: string;
        to?: string;
        accountId?: string;
        threadId?: string;
      };
      resolution?: {
        matchedBy: ResolveMatchedBy;
        threadPolicy?: ResolveThreadPolicy;
        selection?: ResolveSelection;
        fallbackUsed?: boolean;
        search?: string;
        searchFields?: ResolveSearchField[];
      };
    }
  | { ok: true; missing: true }
  | { ok: false; error: ErrorShape };

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeThreadId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return normalizeString(value);
}

function normalizeSelection(value: unknown): ResolveSelection | undefined {
  return value === "most-recent" || value === "least-recent" ? value : undefined;
}

function normalizeThreadPolicy(value: unknown): ResolveThreadPolicy | undefined {
  return value === "exact" ||
    value === "prefer-thread" ||
    value === "most-recent" ||
    value === "channel-root"
    ? value
    : undefined;
}

function normalizeSearchFields(value: unknown): ResolveSearchField[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const fields = value.filter(
    (field): field is ResolveSearchField =>
      field === "key" ||
      field === "sessionId" ||
      field === "label" ||
      field === "displayName" ||
      field === "subject" ||
      field === "derivedTitle" ||
      field === "lastMessage",
  );
  return Array.from(new Set(fields));
}

function normalizeResolvedDeliveryContext(row: GatewaySessionRow):
  | {
      channel?: string;
      to?: string;
      accountId?: string;
      threadId?: string;
    }
  | undefined {
  const normalized =
    normalizeDeliveryContext(row.deliveryContext) ??
    normalizeDeliveryContext({
      channel: row.lastChannel ?? row.channel,
      to: row.lastTo,
      accountId: row.lastAccountId,
    });
  if (!normalized) {
    return undefined;
  }
  return {
    channel: normalizeString(normalized.channel),
    to: normalizeString(normalized.to),
    accountId: normalizeString(normalized.accountId),
    threadId: normalizeThreadId(normalized.threadId),
  };
}

function buildSuccessFromRow(params: {
  row: GatewaySessionRow;
  matchedBy: ResolveMatchedBy;
  threadPolicy?: ResolveThreadPolicy;
  selection?: ResolveSelection;
  fallbackUsed?: boolean;
  search?: string;
  searchFields?: ResolveSearchField[];
}): SessionsResolveResult {
  const parsed = parseAgentSessionKey(params.row.key);
  return {
    ok: true,
    key: params.row.key,
    agentId: parsed?.agentId ? normalizeAgentId(parsed.agentId) : undefined,
    deliveryContext: normalizeResolvedDeliveryContext(params.row),
    resolution: {
      matchedBy: params.matchedBy,
      threadPolicy: params.threadPolicy,
      selection: params.selection,
      fallbackUsed: params.fallbackUsed === true ? true : undefined,
      search: params.search,
      searchFields: params.searchFields?.length ? params.searchFields : undefined,
    },
  };
}

function sortByUpdatedDesc(rows: GatewaySessionRow[]): GatewaySessionRow[] {
  return [...rows].toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function sortByUpdatedAsc(rows: GatewaySessionRow[]): GatewaySessionRow[] {
  return [...rows].toSorted((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
}

function selectRowByOrder(
  rows: GatewaySessionRow[],
  selection?: ResolveSelection,
): GatewaySessionRow[] {
  if (rows.length <= 1) {
    return rows;
  }
  if (selection === "most-recent") {
    return sortByUpdatedDesc(rows).slice(0, 1);
  }
  if (selection === "least-recent") {
    return sortByUpdatedAsc(rows).slice(0, 1);
  }
  return rows;
}

function resolveRowChannel(row: GatewaySessionRow): string | undefined {
  const normalized = normalizeResolvedDeliveryContext(row);
  return normalizeString(normalized?.channel ?? row.lastChannel ?? row.channel);
}

function resolveRowTo(row: GatewaySessionRow): string | undefined {
  return normalizeString(normalizeResolvedDeliveryContext(row)?.to ?? row.lastTo);
}

function resolveRowAccountId(row: GatewaySessionRow): string | undefined {
  return normalizeOptionalAccountId(
    normalizeResolvedDeliveryContext(row)?.accountId ?? row.lastAccountId,
  );
}

function resolveRowThreadId(row: GatewaySessionRow): string | undefined {
  return normalizeThreadId(normalizeResolvedDeliveryContext(row)?.threadId);
}

function matchesSearch(
  row: GatewaySessionRow,
  search: string,
  fields: ResolveSearchField[],
): boolean {
  if (!search) {
    return true;
  }
  const query = search.toLowerCase();
  const values = fields.map((field) => {
    switch (field) {
      case "key":
        return row.key;
      case "sessionId":
        return row.sessionId;
      case "label":
        return row.label;
      case "displayName":
        return row.displayName;
      case "subject":
        return row.subject;
      case "derivedTitle":
        return row.derivedTitle;
      case "lastMessage":
        return row.lastMessagePreview;
      default:
        return undefined;
    }
  });
  return values.some((value) => typeof value === "string" && value.toLowerCase().includes(query));
}

function buildAdvancedResolveNoMatchMessage(params: {
  channel?: string;
  to?: string;
  agentId?: string;
  search?: string;
  threadPolicy?: ResolveThreadPolicy;
}): string {
  const parts: string[] = [];
  if (params.agentId) {
    parts.push(`agentId=${params.agentId}`);
  }
  if (params.channel) {
    parts.push(`channel=${params.channel}`);
  }
  if (params.to) {
    parts.push(`to=${params.to}`);
  }
  if (params.threadPolicy) {
    parts.push(`threadPolicy=${params.threadPolicy}`);
  }
  if (params.search) {
    parts.push(`search=${JSON.stringify(params.search)}`);
  }
  const suffix = parts.length ? ` (${parts.join(", ")})` : "";
  return `No session matched selector filters${suffix}`;
}

function resolveSessionVisibilityFilterOptions(p: SessionsResolveParams) {
  return {
    includeGlobal: p.includeGlobal === true,
    includeUnknown: p.includeUnknown === true,
    spawnedBy: p.spawnedBy,
    agentId: p.agentId,
  };
}

function noSessionFoundResult(params: { p: SessionsResolveParams; message: string }) {
  if (params.p.allowMissing) {
    return { ok: true, missing: true } as const;
  }
  return {
    ok: false,
    error: errorShape(ErrorCodes.INVALID_REQUEST, params.message),
  } as const;
}

/** Rejects sessions whose owning agent no longer exists in config (#65524). */
function validateSessionAgentExists(
  cfg: OpenClawConfig,
  key: string,
  entry?: SessionEntry | null,
  options?: { acpMetadataSessionKey?: string | null },
): SessionsResolveResult | null {
  const deletedAgentId = resolveDeletedAgentIdFromSessionKey(cfg, key, entry, options);
  if (deletedAgentId === null) {
    return null;
  }
  return {
    ok: false,
    error: errorShape(
      ErrorCodes.INVALID_REQUEST,
      `Agent "${deletedAgentId}" no longer exists in configuration`,
    ),
  };
}

function isResolvedSessionKeyVisible(params: {
  cfg: OpenClawConfig;
  p: SessionsResolveParams;
  store: Record<string, SessionEntry>;
  key: string;
}) {
  if (typeof params.p.spawnedBy !== "string" || params.p.spawnedBy.trim().length === 0) {
    return true;
  }
  return filterAndSortSessionEntries({
    cfg: params.cfg,
    store: params.store,
    now: Date.now(),
    opts: resolveSessionVisibilityFilterOptions(params.p),
  }).some(([key]) => key === params.key);
}

function findVisibleSessionIdMatches(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  p: SessionsResolveParams;
  sessionId: string;
}): Array<[string, SessionEntry]> {
  const entries = filterAndSortSessionEntries({
    cfg: params.cfg,
    store: params.store,
    now: Date.now(),
    opts: resolveSessionVisibilityFilterOptions(params.p),
  });
  return entries.filter(
    ([key, entry]) => entry?.sessionId === params.sessionId || key === params.sessionId,
  );
}

export async function resolveSessionKeyFromResolveParams(params: {
  cfg: OpenClawConfig;
  p: SessionsResolveParams;
}): Promise<SessionsResolveResult> {
  const { cfg, p } = params;

  const key = normalizeString(p.key) ?? "";
  const hasKey = key.length > 0;
  const sessionId = normalizeString(p.sessionId) ?? "";
  const hasSessionId = sessionId.length > 0;
  const hasLabel = typeof p.label === "string" && p.label.trim().length > 0;
  const channel = normalizeString(p.channel);
  const to = normalizeString(p.to);
  const accountId = normalizeOptionalAccountId(p.accountId);
  const threadId = normalizeThreadId(p.threadId);
  const search = normalizeString(p.search);
  const searchFields = normalizeSearchFields(p.searchFields);
  const selection = normalizeSelection(p.selection);
  const threadPolicy = normalizeThreadPolicy(p.threadPolicy);
  const activeMinutes =
    typeof p.activeMinutes === "number" && Number.isFinite(p.activeMinutes)
      ? Math.max(1, Math.floor(p.activeMinutes))
      : undefined;

  const hasSelectorFilters =
    Boolean(
      channel ||
      to ||
      accountId ||
      threadId ||
      search ||
      searchFields.length ||
      selection ||
      threadPolicy,
    ) || activeMinutes !== undefined;
  const hasAgentOnlySelector = Boolean(
    p.agentId && !hasKey && !hasSessionId && !hasLabel && !hasSelectorFilters,
  );
  const selectionCount = [
    hasKey,
    hasSessionId,
    hasLabel,
    hasSelectorFilters || hasAgentOnlySelector,
  ].filter(Boolean).length;
  if (selectionCount > 1) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Provide either key, sessionId, label, or selector filters (not multiple)",
      ),
    };
  }
  if (selectionCount === 0) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Either key, sessionId, label, or selector filters are required",
      ),
    };
  }

  if (searchFields.length > 0 && !search) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "searchFields requires search"),
    };
  }

  const effectiveThreadPolicy: ResolveThreadPolicy | undefined = threadId
    ? (threadPolicy ?? "exact")
    : threadPolicy;
  if (threadId && threadPolicy && threadPolicy !== "exact") {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "threadId requires threadPolicy=exact (or omit threadPolicy)",
      ),
    };
  }
  if (effectiveThreadPolicy === "exact" && !threadId) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "threadPolicy=exact requires threadId"),
    };
  }

  if (hasKey) {
    // Key lookups may hit legacy store aliases. Migrate/prune before returning
    // the canonical key so later calls operate on one store identity.
    const target = resolveGatewaySessionStoreTargetWithStore({ cfg, key, clone: false });
    const store = target.store;
    if (store[target.canonicalKey]) {
      if (
        !isResolvedSessionKeyVisible({
          cfg,
          p,
          store,
          key: target.canonicalKey,
        })
      ) {
        return noSessionFoundResult({ p, message: `No session found: ${key}` });
      }
      const agentCheck = validateSessionAgentExists(
        cfg,
        target.canonicalKey,
        store[target.canonicalKey],
        { acpMetadataSessionKey: target.canonicalKey },
      );
      if (agentCheck) {
        return agentCheck;
      }
      return { ok: true, key: target.canonicalKey };
    }
    const legacyKey = target.storeKeys.find((candidate) => store[candidate]);
    if (!legacyKey) {
      return noSessionFoundResult({ p, message: `No session found: ${key}` });
    }
    await canonicalizeSessionEntryAliases({
      storePath: target.storePath,
      target: {
        canonicalKey: target.canonicalKey,
        storeKeys: target.storeKeys,
      },
    });
    const refreshedTarget = resolveGatewaySessionStoreTargetWithStore({
      cfg,
      key: target.canonicalKey,
      clone: false,
    });
    if (
      !isResolvedSessionKeyVisible({
        cfg,
        p,
        store: refreshedTarget.store,
        key: refreshedTarget.canonicalKey,
      })
    ) {
      return noSessionFoundResult({ p, message: `No session found: ${key}` });
    }
    const agentCheckLegacy = validateSessionAgentExists(
      cfg,
      refreshedTarget.canonicalKey,
      refreshedTarget.store[refreshedTarget.canonicalKey],
      { acpMetadataSessionKey: refreshedTarget.canonicalKey },
    );
    if (agentCheckLegacy) {
      return agentCheckLegacy;
    }
    return { ok: true, key: refreshedTarget.canonicalKey };
  }

  if (hasSessionId) {
    // sessionId can collide across stores; delegate selection so exact key
    // matches and ambiguity rules stay shared with other session-id callers.
    const { store } = loadCombinedSessionStoreForGateway(cfg, { agentId: p.agentId });
    const matches = findVisibleSessionIdMatches({ cfg, store, p, sessionId });
    const selection = resolveSessionIdMatchSelection(matches, sessionId);
    if (selection.kind === "none") {
      return noSessionFoundResult({ p, message: `No session found: ${sessionId}` });
    }
    if (selection.kind === "ambiguous") {
      const keys = selection.sessionKeys.join(", ");
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Multiple sessions found for sessionId: ${sessionId} (${keys})`,
        ),
      };
    }
    const selectedEntry = matches.find(([matchKey]) => matchKey === selection.sessionKey)?.[1];
    const agentCheckSessionId = validateSessionAgentExists(
      cfg,
      selection.sessionKey,
      selectedEntry,
    );
    if (agentCheckSessionId) {
      return agentCheckSessionId;
    }
    return { ok: true, key: selection.sessionKey };
  }

  if (hasLabel) {
    const parsedLabel = parseSessionLabel(p.label);
    if (!parsedLabel.ok) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, parsedLabel.error),
      };
    }

    const { storePath, store } = loadCombinedSessionStoreForGateway(cfg, { agentId: p.agentId });
    const list = listSessionsFromStore({
      cfg,
      storePath,
      store,
      opts: {
        includeGlobal: p.includeGlobal === true,
        includeUnknown: p.includeUnknown === true,
        label: parsedLabel.label,
        agentId: p.agentId,
        spawnedBy: p.spawnedBy,
        limit: 2,
      },
    });
    if (list.sessions.length === 0) {
      return noSessionFoundResult({
        p,
        message: `No session found with label: ${parsedLabel.label}`,
      });
    }
    if (list.sessions.length > 1) {
      const keys = list.sessions.map((s) => s.key).join(", ");
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Multiple sessions found with label: ${parsedLabel.label} (${keys})`,
        ),
      };
    }

    const selected = list.sessions[0];
    const agentCheckLabel = validateSessionAgentExists(cfg, selected.key);
    if (agentCheckLabel) {
      return agentCheckLabel;
    }
    return buildSuccessFromRow({ row: selected, matchedBy: "label" });
  }

  const hasTargetSelector = Boolean(channel || to || accountId || threadId);
  if (!hasTargetSelector && !search && !hasAgentOnlySelector) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Selector filters require at least one of channel, to, threadId, or search",
      ),
    };
  }

  const { storePath, store } = loadCombinedSessionStoreForGateway(cfg, { agentId: p.agentId });
  const resolvedSearchFields = search
    ? searchFields.length
      ? searchFields
      : DEFAULT_SEARCH_FIELDS
    : [];
  const list = listSessionsFromStore({
    cfg,
    storePath,
    store,
    opts: {
      includeGlobal: p.includeGlobal === true,
      includeUnknown: p.includeUnknown === true,
      spawnedBy: p.spawnedBy,
      agentId: p.agentId,
      activeMinutes,
      includeDerivedTitles: resolvedSearchFields.includes("derivedTitle"),
      includeLastMessage: resolvedSearchFields.includes("lastMessage"),
    },
  });
  let matches = list.sessions.filter((row) => {
    const rowChannel = resolveRowChannel(row);
    const rowTo = resolveRowTo(row);
    const rowAccountId = resolveRowAccountId(row);
    const rowThreadId = resolveRowThreadId(row);
    if (channel && rowChannel !== channel) {
      return false;
    }
    if (to && rowTo !== to) {
      return false;
    }
    if (accountId && rowAccountId !== accountId) {
      return false;
    }
    if (threadId && rowThreadId !== threadId) {
      return false;
    }
    return matchesSearch(row, search ?? "", resolvedSearchFields);
  });
  if (hasAgentOnlySelector) {
    const channelRoots = matches.filter(
      (row) => resolveRowChannel(row) && resolveRowTo(row) && !resolveRowThreadId(row),
    );
    if (channelRoots.length > 0) {
      matches = channelRoots;
    } else {
      const deliverable = matches.filter((row) => resolveRowChannel(row) && resolveRowTo(row));
      if (deliverable.length > 0) {
        matches = deliverable;
      }
    }
  }

  let fallbackUsed = false;
  if (effectiveThreadPolicy === "channel-root") {
    matches = matches.filter((row) => !resolveRowThreadId(row));
  } else if (effectiveThreadPolicy === "prefer-thread") {
    const threaded = matches.filter((row) => resolveRowThreadId(row));
    if (threaded.length > 0) {
      matches = threaded;
    } else {
      fallbackUsed = true;
      matches = matches.filter((row) => !resolveRowThreadId(row));
    }
  } else if (effectiveThreadPolicy === "most-recent") {
    const threaded = sortByUpdatedDesc(matches.filter((row) => resolveRowThreadId(row)));
    if (threaded.length > 0) {
      matches = threaded.slice(0, 1);
    } else if (p.allowChannelRootFallback === true) {
      fallbackUsed = true;
      matches = sortByUpdatedDesc(matches.filter((row) => !resolveRowThreadId(row))).slice(0, 1);
    } else {
      matches = [];
    }
  }

  if (matches.length === 0) {
    return noSessionFoundResult({
      p,
      message: buildAdvancedResolveNoMatchMessage({
        channel,
        to,
        agentId: normalizeString(p.agentId),
        search,
        threadPolicy: effectiveThreadPolicy,
      }),
    });
  }

  const effectiveSelection = selection ?? (hasAgentOnlySelector ? "most-recent" : undefined);
  const selected = selectRowByOrder(matches, effectiveSelection);
  if (selected.length > 1) {
    const keys = sortByUpdatedDesc(selected)
      .slice(0, 10)
      .map((row) => row.key)
      .join(", ");
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Multiple sessions matched selector filters (${keys}); add selection or narrow the filters`,
      ),
    };
  }

  const agentCheckSelected = validateSessionAgentExists(cfg, selected[0].key);
  if (agentCheckSelected) {
    return agentCheckSelected;
  }

  const matchedBy: ResolveMatchedBy = hasAgentOnlySelector
    ? "selector"
    : hasTargetSelector && search
      ? "selector"
      : hasTargetSelector
        ? "delivery-target"
        : "search";

  return buildSuccessFromRow({
    row: selected[0],
    matchedBy,
    threadPolicy: effectiveThreadPolicy,
    selection: effectiveSelection,
    fallbackUsed,
    search,
    searchFields: resolvedSearchFields,
  });
}
