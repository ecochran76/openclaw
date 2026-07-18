/**
 * Splits SDK tools from OpenClaw tool definitions for provider calls.
 */
import { toToolDefinitions } from "../agent-tool-definition-adapter.js";
import type { HookContext } from "../agent-tools.before-tool-call.js";
import type { AgentTool } from "../runtime/index.js";

// Keep Pi's built-in `tools` allowlist aligned with the same OpenClaw-managed
// custom tool definitions we pass through `customTools`.
type AnyAgentTool = AgentTool;

export function splitSdkTools(options: {
  tools: AnyAgentTool[];
  sandboxEnabled: boolean;
  toolHookContext?: HookContext;
}): {
  builtInTools: string[];
  customTools: ReturnType<typeof toToolDefinitions>;
} {
  const { tools, toolHookContext } = options;
  const customTools = toToolDefinitions(tools, toolHookContext);
  return {
    builtInTools: customTools.map((tool) => tool.name).filter(Boolean),
    customTools,
  };
}
