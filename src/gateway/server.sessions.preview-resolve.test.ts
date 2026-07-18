/**
 * Gateway session preview resolve tests.
 */
import path from "node:path";
import { expect, test } from "vitest";
import { clearSessionStoreCacheForTest } from "../config/sessions.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  applySessionEntryLifecycleMutation,
  listSessionEntries,
  loadSessionEntry,
  updateSessionLastRoute,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createToolSummaryPreviewTranscriptLines } from "./session-preview.test-helpers.js";
import { rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionStoreEntry,
  getMainPreviewEntry,
  directSessionReq,
  loadSeededTranscriptEvents,
  seedLinearSessionTranscript,
  seedSessionTranscript,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

async function replaceSessionEntries(
  storePath: string,
  entries: Record<string, Partial<SessionEntry>>,
  agentId = "main",
): Promise<void> {
  clearSessionStoreCacheForTest();
  await applySessionEntryLifecycleMutation({
    agentId,
    storePath,
    removals: listSessionEntries({ agentId, storePath }).map(({ sessionKey }) => ({ sessionKey })),
    upserts: Object.entries(entries).map(([sessionKey, entry]) => ({
      sessionKey,
      entry: {
        updatedAt: 0,
        ...entry,
        sessionId: entry.sessionId ?? sessionKey,
      },
    })),
    skipMaintenance: true,
  });
  clearSessionStoreCacheForTest();
}

async function previewMainAliasFromStore(params: {
  transcripts: Record<string, string>;
  store: Record<string, { sessionId: string; updatedAt: number }>;
}): Promise<Awaited<ReturnType<typeof getMainPreviewEntry>>> {
  const { dir } = await createSessionStoreDir();
  const storePath = path.join(dir, "agents", "ops", "sessions", "sessions.json");
  testState.sessionStorePath = storePath;
  testState.agentsConfig = { list: [{ id: "ops", default: true }] };
  testState.sessionConfig = { mainKey: "work" };

  await writeSessionStore({ agentId: "ops", entries: {} });
  await replaceSessionEntries(storePath, params.store, "ops");
  for (const [sessionKey, entry] of Object.entries(params.store)) {
    const content = params.transcripts[entry.sessionId];
    if (content) {
      await seedSessionTranscript({
        agentId: "ops",
        sessionId: entry.sessionId,
        sessionKey,
        storePath,
        messages: [{ role: "assistant", content }],
      });
    }
  }

  const { ws } = await openClient();
  try {
    return await getMainPreviewEntry(ws);
  } finally {
    ws.close();
  }
}

test("sessions.preview returns transcript previews", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-preview";
  const lines = createToolSummaryPreviewTranscriptLines(sessionId);

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(sessionId),
    },
  });
  await seedSessionTranscript({
    sessionId,
    sessionKey: "agent:main:main",
    storePath,
    messages: lines
      .map((line) => JSON.parse(line) as { message?: Record<string, unknown> })
      .map((record) => record.message)
      .filter((message): message is Record<string, unknown> => Boolean(message))
      .map((message) => Object.assign({ role: String(message.role) }, message)),
  });

  const preview = await directSessionReq<{
    previews: Array<{
      key: string;
      status: string;
      items: Array<{ role: string; text: string }>;
    }>;
  }>("sessions.preview", { keys: ["main"], limit: 3, maxChars: 120 });
  expect(preview.ok).toBe(true);
  const entry = preview.payload?.previews[0];
  expect(entry?.key).toBe("main");
  expect(entry?.status).toBe("ok");
  expect(entry?.items.map((item) => item.role)).toEqual(["assistant", "tool", "assistant"]);
  expect(entry?.items[1]?.text).toContain("call weather");
});

test("sessions.preview resolves legacy main alias with custom mainKey", async () => {
  const sessionId = "sess-legacy-main";

  const entry = await previewMainAliasFromStore({
    transcripts: {
      [sessionId]: "Legacy alias transcript",
    },
    store: {
      "agent:ops:main": {
        sessionId,
        updatedAt: Date.now(),
      },
    },
  });
  expect(entry?.items[0]?.text).toContain("Legacy alias transcript");
});

test("sessions.preview prefers the freshest duplicate row for a legacy main alias", async () => {
  const entry = await previewMainAliasFromStore({
    transcripts: {
      "sess-stale-main": "stale preview",
      "sess-fresh-main": "fresh preview",
    },
    store: {
      "agent:ops:work": {
        sessionId: "sess-stale-main",
        updatedAt: 1,
      },
      "agent:ops:main": {
        sessionId: "sess-fresh-main",
        updatedAt: 2,
      },
    },
  });
  expect(entry?.items[0]?.text).toContain("fresh preview");
});

test("sessions.resolve and mutators clean legacy main-alias ghost keys", async () => {
  const { dir } = await createSessionStoreDir();
  const storePath = path.join(dir, "agents", "ops", "sessions", "sessions.json");
  testState.sessionStorePath = storePath;
  testState.agentsConfig = { list: [{ id: "ops", default: true }] };
  testState.sessionConfig = { mainKey: "work" };
  const sessionId = "sess-alias-cleanup";
  await writeSessionStore({ agentId: "ops", entries: {} });
  await seedLinearSessionTranscript({
    agentId: "ops",
    contents: Array.from({ length: 8 }, (_, index) => `line ${index}`),
    sessionId,
    sessionKey: "agent:ops:work",
    storePath,
  });

  const writeRawStore = async (store: Record<string, Partial<SessionEntry>>) => {
    await replaceSessionEntries(storePath, store, "ops");
  };
  const readStoreKeys = () =>
    listSessionEntries({ agentId: "ops", storePath }).map(({ sessionKey }) => sessionKey);
  const readWorkEntry = () =>
    loadSessionEntry({
      agentId: "ops",
      sessionKey: "agent:ops:work",
      storePath,
    });

  await writeRawStore({
    "agent:ops:main": { sessionId, updatedAt: Date.now() - 1_000 },
  });

  const { ws } = await openClient();

  const resolved = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
    key: "main",
  });
  expect(resolved.ok).toBe(true);
  expect(resolved.payload?.key).toBe("agent:ops:work");
  expect(readStoreKeys().toSorted()).toEqual(["agent:ops:work"]);

  await writeRawStore({
    "agent:ops:work": readWorkEntry() ?? { sessionId },
    "agent:ops:main": readWorkEntry() ?? { sessionId },
  });
  const patched = await rpcReq<{ ok: true; key: string }>(ws, "sessions.patch", {
    key: "main",
    thinkingLevel: "medium",
  });
  expect(patched.ok).toBe(true);
  expect(patched.payload?.key).toBe("agent:ops:work");
  expect(readStoreKeys().toSorted()).toEqual(["agent:ops:work"]);
  expect(readWorkEntry()?.thinkingLevel).toBe("medium");

  await writeRawStore({
    "agent:ops:work": readWorkEntry() ?? { sessionId },
    "agent:ops:main": readWorkEntry() ?? { sessionId },
  });
  const compacted = await rpcReq<{ ok: true; compacted: boolean }>(ws, "sessions.compact", {
    key: "main",
    maxLines: 3,
  });
  expect(compacted.ok).toBe(true);
  expect(compacted.payload?.compacted).toBe(true);
  expect(readStoreKeys().toSorted()).toEqual(["agent:ops:work"]);
  const compactedEvents = await loadSeededTranscriptEvents({
    agentId: "ops",
    sessionId,
    sessionKey: "agent:ops:work",
    storePath,
  });
  expect(
    compactedEvents
      .map((event) =>
        event && typeof event === "object" && "message" in event
          ? (event as { message?: { content?: unknown } }).message?.content
          : undefined,
      )
      .filter((content) => content !== undefined),
  ).toEqual(["line 6", "line 7"]);

  await writeRawStore({
    "agent:ops:work": readWorkEntry() ?? { sessionId },
    "agent:ops:main": readWorkEntry() ?? { sessionId },
  });
  const reset = await rpcReq<{ ok: true; key: string }>(ws, "sessions.reset", { key: "main" });
  expect(reset.ok).toBe(true);
  expect(reset.payload?.key).toBe("agent:ops:work");
  expect(readStoreKeys().toSorted()).toEqual(["agent:ops:work"]);

  ws.close();
});

test("sessions.resolve by sessionId ignores fuzzy-search list limits and returns the exact match", async () => {
  await createSessionStoreDir();
  const now = Date.now();
  const entries: Record<string, { sessionId: string; updatedAt: number; label?: string }> = {
    "agent:main:subagent:target": {
      sessionId: "sess-target-exact",
      updatedAt: now - 20_000,
    },
  };
  for (let i = 0; i < 9; i += 1) {
    entries[`agent:main:subagent:noisy-${i}`] = {
      sessionId: `sess-noisy-${i}`,
      updatedAt: now - i * 1_000,
      label: `sess-target-exact noisy ${i}`,
    };
  }
  await writeSessionStore({ entries });

  const { ws } = await openClient();
  const resolved = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
    sessionId: "sess-target-exact",
  });

  expect(resolved.ok).toBe(true);
  expect(resolved.payload?.key).toBe("agent:main:subagent:target");
});

test("sessions.resolve can probe a missing selector without returning an RPC error", async () => {
  await createSessionStoreDir();
  const { ws } = await openClient();

  const resolved = await rpcReq<{ ok: false }>(ws, "sessions.resolve", {
    key: "agent:main:missing",
    allowMissing: true,
  });

  expect(resolved.ok).toBe(true);
  expect(resolved.payload).toEqual({ ok: false });
});

test("sessions.resolve by key respects spawnedBy visibility filters", async () => {
  await createSessionStoreDir();
  const now = Date.now();
  await writeSessionStore({
    entries: {
      "agent:main:subagent:visible-parent": {
        sessionId: "sess-visible-parent",
        updatedAt: now - 3_000,
        spawnedBy: "agent:main:main",
      },
      "agent:main:subagent:hidden-parent": {
        sessionId: "sess-hidden-parent",
        updatedAt: now - 2_000,
        spawnedBy: "agent:main:main",
      },
      "agent:main:subagent:shared-child-key-filter": {
        sessionId: "sess-shared-child-key-filter",
        updatedAt: now - 1_000,
        spawnedBy: "agent:main:subagent:hidden-parent",
      },
    },
  });

  const { ws } = await openClient();
  const resolved = await rpcReq(ws, "sessions.resolve", {
    key: "agent:main:subagent:shared-child-key-filter",
    spawnedBy: "agent:main:subagent:visible-parent",
  });

  expect(resolved.ok).toBe(false);
  expect(resolved.error?.message).toContain(
    "No session found: agent:main:subagent:shared-child-key-filter",
  );
});

test("sessions.resolve supports delivery-target, thread-policy, and search selectors", async () => {
  await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "dev-openclaw", default: true }] };
  const now = Date.now();
  const rootKey = "agent:dev-openclaw:slack:channel:c0ag96mgjtv";
  const threadOldKey = "agent:dev-openclaw:slack:channel:c0ag96mgjtv:thread:1773000000.111111";
  const threadNewKey = "agent:dev-openclaw:slack:channel:c0ag96mgjtv:thread:1773000000.222222";
  const rootOnlyKey = "agent:dev-openclaw:slack:channel:c0onlyroot";

  await writeSessionStore({
    entries: {
      [rootKey]: {
        sessionId: "sess-root",
        updatedAt: now - 40_000,
        deliveryContext: {
          channel: "slack",
          to: "channel:C0AG96MGJTV",
        },
      },
      [threadOldKey]: {
        sessionId: "sess-thread-old",
        updatedAt: now - 20_000,
        deliveryContext: {
          channel: "slack",
          to: "channel:C0AG96MGJTV",
          threadId: "1773000000.111111",
        },
      },
      [threadNewKey]: {
        sessionId: "sess-thread-new",
        updatedAt: now - 10_000,
        deliveryContext: {
          channel: "slack",
          to: "channel:C0AG96MGJTV",
          threadId: "1773000000.222222",
        },
      },
      [rootOnlyKey]: {
        sessionId: "sess-root-only",
        updatedAt: now - 5_000,
        deliveryContext: {
          channel: "slack",
          to: "channel:C0ONLYROOT",
        },
      },
    },
  });

  await Promise.all([
    seedSessionTranscript({
      agentId: "dev-openclaw",
      sessionId: "sess-root",
      sessionKey: rootKey,
      storePath: testState.sessionStorePath,
      messages: [{ role: "user", content: "a2a feature dev root kickoff" }],
    }),
    seedSessionTranscript({
      agentId: "dev-openclaw",
      sessionId: "sess-thread-old",
      sessionKey: threadOldKey,
      storePath: testState.sessionStorePath,
      messages: [{ role: "user", content: "a2a feature dev thread old" }],
    }),
    seedSessionTranscript({
      agentId: "dev-openclaw",
      sessionId: "sess-thread-new",
      sessionKey: threadNewKey,
      storePath: testState.sessionStorePath,
      messages: [{ role: "user", content: "a2a feature dev thread new" }],
    }),
    seedSessionTranscript({
      agentId: "dev-openclaw",
      sessionId: "sess-root-only",
      sessionKey: rootOnlyKey,
      storePath: testState.sessionStorePath,
      messages: [{ role: "user", content: "root only fallback target" }],
    }),
  ]);

  const devStorePath = resolveStorePath(undefined, { agentId: "dev-openclaw" });
  await Promise.all([
    updateSessionLastRoute({
      storePath: devStorePath,
      sessionKey: rootKey,
      deliveryContext: { channel: "slack", to: "channel:C0AG96MGJTV" },
    }),
    updateSessionLastRoute({
      storePath: devStorePath,
      sessionKey: threadOldKey,
      deliveryContext: {
        channel: "slack",
        to: "channel:C0AG96MGJTV",
        threadId: "1773000000.111111",
      },
    }),
    updateSessionLastRoute({
      storePath: devStorePath,
      sessionKey: threadNewKey,
      deliveryContext: {
        channel: "slack",
        to: "channel:C0AG96MGJTV",
        threadId: "1773000000.222222",
      },
    }),
    updateSessionLastRoute({
      storePath: devStorePath,
      sessionKey: rootOnlyKey,
      deliveryContext: { channel: "slack", to: "channel:C0ONLYROOT" },
    }),
  ]);

  const { ws } = await openClient();

  const resolvedMostRecentThread = await rpcReq<{
    ok: true;
    key: string;
    deliveryContext?: { channel?: string; to?: string; threadId?: string };
    resolution?: { matchedBy?: string; threadPolicy?: string; fallbackUsed?: boolean };
  }>(ws, "sessions.resolve", {
    channel: "slack",
    to: "channel:C0AG96MGJTV",
    threadPolicy: "most-recent",
    includeGlobal: false,
    includeUnknown: false,
  });
  expect(resolvedMostRecentThread.ok).toBe(true);
  expect(resolvedMostRecentThread.payload?.key).toBe(threadNewKey);
  expect(resolvedMostRecentThread.payload?.deliveryContext).toEqual({
    channel: "slack",
    to: "channel:C0AG96MGJTV",
    threadId: "1773000000.222222",
  });
  expect(resolvedMostRecentThread.payload?.resolution).toMatchObject({
    matchedBy: "delivery-target",
    threadPolicy: "most-recent",
  });

  const resolvedBySearch = await rpcReq<{
    ok: true;
    key: string;
    resolution?: { matchedBy?: string; threadPolicy?: string; selection?: string };
  }>(ws, "sessions.resolve", {
    agentId: "dev-openclaw",
    search: "a2a feature dev",
    searchFields: ["derivedTitle"],
    selection: "most-recent",
    threadPolicy: "prefer-thread",
    includeGlobal: false,
    includeUnknown: false,
  });
  expect(resolvedBySearch.ok).toBe(true);
  expect(resolvedBySearch.payload?.key).toBe(threadNewKey);
  expect(resolvedBySearch.payload?.resolution).toMatchObject({
    matchedBy: "search",
    threadPolicy: "prefer-thread",
    selection: "most-recent",
  });

  const resolvedWithFallback = await rpcReq<{
    ok: true;
    key: string;
    resolution?: { fallbackUsed?: boolean; threadPolicy?: string };
  }>(ws, "sessions.resolve", {
    channel: "slack",
    to: "channel:C0ONLYROOT",
    threadPolicy: "most-recent",
    allowChannelRootFallback: true,
    includeGlobal: false,
    includeUnknown: false,
  });
  expect(resolvedWithFallback.ok).toBe(true);
  expect(resolvedWithFallback.payload?.key).toBe(rootOnlyKey);
  expect(resolvedWithFallback.payload?.resolution).toMatchObject({
    threadPolicy: "most-recent",
    fallbackUsed: true,
  });

  const ambiguous = await rpcReq(ws, "sessions.resolve", {
    agentId: "dev-openclaw",
    search: "a2a feature dev",
    searchFields: ["derivedTitle"],
    threadPolicy: "prefer-thread",
    includeGlobal: false,
    includeUnknown: false,
  });
  expect(ambiguous.ok).toBe(false);
  expect(ambiguous.error?.message ?? "").toMatch(/Multiple sessions matched selector filters/i);

  ws.close();
});
