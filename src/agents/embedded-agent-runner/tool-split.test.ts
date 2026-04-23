import { describe, expect, it, vi } from "vitest";
import { splitSdkTools } from "./tool-split.js";

function createTool(name: string) {
  return {
    name,
    description: `${name} description`,
    parameters: {},
    execute: vi.fn(),
  } as never;
}

describe("splitSdkTools", () => {
  it("keeps OpenClaw custom tools enabled in Pi's explicit tool allowlist", () => {
    const result = splitSdkTools({
      tools: [createTool("exec"), createTool("message"), createTool("memory_search")],
      sandboxEnabled: false,
    });

    expect(result.builtInTools).toEqual(["exec", "message", "memory_search"]);
    expect(result.customTools.map((tool) => tool.name)).toEqual([
      "exec",
      "message",
      "memory_search",
    ]);
  });
});
