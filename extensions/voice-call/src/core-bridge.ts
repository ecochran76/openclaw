// Voice Call plugin module implements core bridge behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { OpenClawPluginApi } from "../api.js";
import type { VoiceCallCoreSessionConfig, VoiceCallTtsConfig } from "./config.js";

// Narrow core runtime/config contracts consumed by the voice-call plugin.

/** Core config subset read by voice-call helpers. */
export type CoreConfig = OpenClawConfig & {
  session?: OpenClawConfig["session"] & VoiceCallCoreSessionConfig & { store?: string };
  messages?: OpenClawConfig["messages"] & {
    tts?: VoiceCallTtsConfig;
  };
};

/** Agent runtime API subset exposed through the plugin SDK. */
export type CoreAgentDeps = OpenClawPluginApi["runtime"]["agent"];
