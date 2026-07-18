/**
 * Embedded agent runtime barrel.
 *
 * Runtime callers import this surface for run lifecycle helpers without pulling
 * in the larger embedded-agent module path directly.
 */
export {
  abortAndDrainEmbeddedAgentRun,
  abortEmbeddedAgentRun,
  abortEmbeddedAgentRun as abortEmbeddedPiRun,
  isEmbeddedAgentRunActive,
  isEmbeddedAgentRunActive as isEmbeddedPiRunActive,
  isEmbeddedAgentRunStreaming,
  isEmbeddedAgentRunStreaming as isEmbeddedPiRunStreaming,
  resolveActiveEmbeddedRunSessionId,
  resolveActiveEmbeddedRunSessionIdBySessionFile,
  runEmbeddedAgent,
  resolveEmbeddedSessionLane,
  waitForEmbeddedAgentRunEnd,
  waitForEmbeddedAgentRunEnd as waitForEmbeddedPiRunEnd,
} from "./embedded-agent.js";
