/**
 * subagents built-in tool.
 *
 * Lists active and recent subagents controlled by the caller's session tree.
 */
import { Type } from "typebox";
import {
  resolveSubagentLabel,
  resolveSubagentTargetFromRuns,
} from "../../auto-reply/reply/subagents-utils.js";
import { getRuntimeConfig } from "../../config/config.js";
import { optionalPositiveIntegerSchema, optionalStringEnum } from "../schema/typebox.js";
import {
  DEFAULT_RECENT_MINUTES,
  killAllControlledSubagentRuns,
  killControlledSubagentRun,
  listControlledSubagentRuns,
  MAX_RECENT_MINUTES,
  resolveSubagentController,
  steerControlledSubagentRun,
} from "../subagent-control.js";
import { buildSubagentList } from "../subagent-list.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readPositiveIntegerParam, readStringParam } from "./common.js";

const SUBAGENT_ACTIONS = ["list", "kill", "steer"] as const;
type SubagentAction = (typeof SUBAGENT_ACTIONS)[number];

const SubagentsToolSchema = Type.Object({
  action: optionalStringEnum(SUBAGENT_ACTIONS),
  target: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  recentMinutes: optionalPositiveIntegerSchema(),
});

function controlTargetError(value: string) {
  return `No matching subagent target: ${value}.`;
}

/** Creates the subagents list tool scoped to the caller's controlled session tree. */
export function createSubagentsTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Subagents",
    name: "subagents",
    description:
      "List active and recent subagents for the requester session. If sessions_yield exists, use it for completion; do not poll wait loops.",
    parameters: SubagentsToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = (readStringParam(params, "action") ?? "list") as SubagentAction;
      const cfg = getRuntimeConfig();
      const recentMinutesRaw = readPositiveIntegerParam(params, "recentMinutes");
      const recentMinutes =
        recentMinutesRaw === undefined
          ? DEFAULT_RECENT_MINUTES
          : Math.min(MAX_RECENT_MINUTES, recentMinutesRaw);
      const controller = resolveSubagentController({
        cfg,
        agentSessionKey: opts?.agentSessionKey,
      });
      // The caller only sees subagents controlled by its effective controller session.
      const runs = listControlledSubagentRuns(controller.controllerSessionKey);

      if (action === "list") {
        const list = buildSubagentList({
          cfg,
          runs,
          recentMinutes,
        });
        return jsonResult({
          status: "ok",
          action: "list",
          requesterSessionKey: controller.controllerSessionKey,
          callerSessionKey: controller.callerSessionKey,
          callerIsSubagent: controller.callerIsSubagent,
          total: list.total,
          active: list.active.map(({ line: _line, ...view }) => view),
          recent: list.recent.map(({ line: _line, ...view }) => view),
          text: list.text,
        });
      }

      if (action === "kill" && readStringParam(params, "target") === "all") {
        const result = await killAllControlledSubagentRuns({ cfg, controller, runs });
        return jsonResult({
          ...result,
          action: "kill",
          target: "all",
          text: `killed ${result.killed} subagent${result.killed === 1 ? "" : "s"}.`,
        });
      }

      const target = resolveSubagentTargetFromRuns({
        runs,
        token: readStringParam(params, "target"),
        recentWindowMinutes: recentMinutes,
        label: resolveSubagentLabel,
        isActive: (entry) => !entry.endedAt,
        errors: {
          missingTarget: "Missing subagent target.",
          invalidIndex: controlTargetError,
          unknownSession: controlTargetError,
          ambiguousLabel: (value) => `Ambiguous subagent label: ${value}.`,
          ambiguousLabelPrefix: (value) => `Ambiguous subagent label prefix: ${value}.`,
          ambiguousRunIdPrefix: (value) => `Ambiguous subagent run id prefix: ${value}.`,
          unknownTarget: controlTargetError,
        },
      });
      if (!target.entry) {
        return jsonResult({
          status: "error",
          error: target.error ?? "No matching subagent target.",
        });
      }

      if (action === "kill") {
        return jsonResult(
          await killControlledSubagentRun({
            cfg,
            controller,
            entry: target.entry,
          }),
        );
      }

      if (action === "steer") {
        const message = readStringParam(params, "message");
        if (!message) {
          return jsonResult({
            status: "error",
            error: "Missing steer message.",
          });
        }
        return jsonResult(
          await steerControlledSubagentRun({
            cfg,
            controller,
            entry: target.entry,
            message,
          }),
        );
      }

      return jsonResult({
        status: "error",
        error: "Unsupported action.",
      });
    },
  };
}
