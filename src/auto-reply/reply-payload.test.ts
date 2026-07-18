// Reply payload tests cover internal reply metadata contracts.
import { describe, expect, it } from "vitest";
import {
  getReplyPayloadMetadata,
  readPairingQrReplyChannelData,
  setReplyPayloadMetadata,
} from "./reply-payload.js";

describe("pairing QR reply channel data", () => {
  it("reads the private pairing QR payload metadata", () => {
    const channelData = {
      openclawPairingQr: {
        setupCode: "setup-code",
        expiresAtMs: 1_800_000_000_000,
      },
    };

    expect(readPairingQrReplyChannelData({ channelData })).toEqual({
      setupCode: "setup-code",
      expiresAtMs: 1_800_000_000_000,
    });
  });

  it("ignores malformed pairing QR metadata", () => {
    expect(
      readPairingQrReplyChannelData({
        channelData: {
          openclawPairingQr: {
            setupCode: "",
            expiresAtMs: 0,
          },
        },
      }),
    ).toBeUndefined();
  });
});

describe("reply payload metadata", () => {
  it("merges metadata across separately loaded module copies", async () => {
    const moduleCopy = await import(
      new URL("./reply-payload.ts?reply-payload-metadata-copy", import.meta.url).href
    );
    const payload = { text: "Shared reply" };

    setReplyPayloadMetadata(payload, { assistantMessageIndex: 2 });
    moduleCopy.setReplyPayloadMetadata(payload, { assistantTranscriptOwned: true });

    expect(getReplyPayloadMetadata(payload)).toEqual({
      assistantMessageIndex: 2,
      assistantTranscriptOwned: true,
    });
    expect(moduleCopy.getReplyPayloadMetadata(payload)).toEqual({
      assistantMessageIndex: 2,
      assistantTranscriptOwned: true,
    });

    setReplyPayloadMetadata(payload, { pendingFinalDeliveryIntentId: "pending-1" });
    expect(moduleCopy.getReplyPayloadMetadata(payload)).toEqual({
      assistantMessageIndex: 2,
      assistantTranscriptOwned: true,
      pendingFinalDeliveryIntentId: "pending-1",
    });
    expect(Object.keys(payload)).toEqual(["text"]);
  });

  it("retains frozen payload metadata across separately loaded module copies", async () => {
    const moduleCopy = await import(
      new URL("./reply-payload.ts?reply-payload-frozen-metadata-copy", import.meta.url).href
    );
    const payload = Object.freeze({ text: "Frozen reply" });

    expect(setReplyPayloadMetadata(payload, { assistantMessageIndex: 3 })).toBe(payload);
    expect(moduleCopy.getReplyPayloadMetadata(payload)).toEqual({ assistantMessageIndex: 3 });
    expect(moduleCopy.setReplyPayloadMetadata(payload, { assistantTranscriptOwned: true })).toBe(
      payload,
    );
    expect(getReplyPayloadMetadata(payload)).toEqual({
      assistantMessageIndex: 3,
      assistantTranscriptOwned: true,
    });
    expect(moduleCopy.getReplyPayloadMetadata(payload)).toEqual({
      assistantMessageIndex: 3,
      assistantTranscriptOwned: true,
    });
    expect(Object.getOwnPropertySymbols(payload)).toEqual([]);
  });

  it("keeps WeakMap metadata authoritative when proxy extensibility reflection throws", () => {
    const payload = new Proxy(
      { text: "Proxied reply" },
      {
        isExtensible() {
          throw new Error("extensibility denied");
        },
      },
    );

    expect(setReplyPayloadMetadata(payload, { assistantMessageIndex: 4 })).toBe(payload);
    expect(getReplyPayloadMetadata(payload)).toEqual({ assistantMessageIndex: 4 });
  });

  it("keeps WeakMap metadata authoritative when proxy symbol attachment throws", () => {
    const payload = new Proxy(
      { text: "Proxied reply" },
      {
        defineProperty() {
          throw new Error("symbol attachment denied");
        },
      },
    );

    expect(setReplyPayloadMetadata(payload, { assistantTranscriptOwned: true })).toBe(payload);
    expect(getReplyPayloadMetadata(payload)).toEqual({ assistantTranscriptOwned: true });
  });

  it("returns undefined when a fresh proxy rejects symbol metadata reads", () => {
    const payload = new Proxy(
      {},
      {
        get(_target, property) {
          if (typeof property === "symbol") {
            throw new Error("symbol read denied");
          }
          return undefined;
        },
      },
    );

    expect(getReplyPayloadMetadata(payload)).toBeUndefined();
  });
});
