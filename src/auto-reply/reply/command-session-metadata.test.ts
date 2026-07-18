import { describe, expect, it } from "vitest";
import {
  markCommandSessionMetadataChanged,
  takeCommandSessionMetadataChanges,
} from "./command-session-metadata.js";

describe("command-session-metadata", () => {
  it("merges and consumes changes across separately loaded module copies", async () => {
    const moduleCopy = await import(
      new URL("./command-session-metadata.ts?command-metadata-copy", import.meta.url).href
    );
    const result = {};

    markCommandSessionMetadataChanged({
      agentId: "main",
      ctx: result,
      rootCtx: result,
      sessionKey: "agent:main:main",
    });
    moduleCopy.markCommandSessionMetadataChanged({
      agentId: "worker",
      ctx: result,
      rootCtx: result,
      sessionKey: "agent:worker:main",
    });

    expect(takeCommandSessionMetadataChanges(result)).toEqual([
      {
        agentId: "main",
        reason: "command-metadata",
        sessionKey: "agent:main:main",
      },
      {
        agentId: "worker",
        reason: "command-metadata",
        sessionKey: "agent:worker:main",
      },
    ]);
    expect(moduleCopy.takeCommandSessionMetadataChanges(result)).toBeUndefined();
  });

  it("records and consumes metadata changes for frozen command results", () => {
    const result = Object.freeze({});

    expect(() =>
      markCommandSessionMetadataChanged({
        agentId: "main",
        ctx: result,
        rootCtx: result,
        sessionKey: "agent:main:main",
      }),
    ).not.toThrow();
    expect(takeCommandSessionMetadataChanges(result)).toEqual([
      {
        agentId: "main",
        reason: "command-metadata",
        sessionKey: "agent:main:main",
      },
    ]);
    expect(takeCommandSessionMetadataChanges(result)).toBeUndefined();
  });
});
