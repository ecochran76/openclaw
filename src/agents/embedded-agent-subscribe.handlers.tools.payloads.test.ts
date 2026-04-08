import { describe, expect, it } from "vitest";
import {
  buildA2AApprovalReplyPayload,
  buildExecApprovalReplyPayload,
  readA2APermissionApprovalDetails,
  readExecApprovalPendingDetails,
  readExecApprovalUnavailableDetails,
} from "./embedded-agent-subscribe.handlers.tools.payloads.js";

describe("embedded agent tool approval payload helpers", () => {
  it("reads exec approval pending payloads", () => {
    const details = readExecApprovalPendingDetails({
      details: {
        status: "approval-pending",
        approvalId: "approval-1",
        approvalSlug: "slug-1",
        host: "gateway",
        command: "npm test",
      },
    });

    expect(details).toMatchObject({
      approvalId: "approval-1",
      approvalSlug: "slug-1",
      host: "gateway",
      command: "npm test",
    });
  });

  it("reads exec approval unavailable payloads", () => {
    const details = readExecApprovalUnavailableDetails({
      details: {
        status: "approval-unavailable",
        reason: "initiating-platform-disabled",
      },
    });

    expect(details).toMatchObject({
      reason: "initiating-platform-disabled",
    });
  });

  it("reads a2a approval payloads and reuses the structured reply builder", () => {
    const approval = readA2APermissionApprovalDetails({
      details: {
        status: "forbidden",
        pendingApproval: {
          approvalId: "approval-2",
          state: "pending",
          expiresAt: 1234,
        },
        permissionRequest: {
          kind: "config_permission_request",
          reason: "agent_to_agent_disabled",
          action: "status",
          requesterAgentId: "dev-agent",
          targetAgentId: "gpod",
          retryable: true,
          askUser: "Allow?",
          suggestedChanges: [
            {
              path: "tools.agentToAgent.enabled",
              value: true,
            },
          ],
        },
      },
    });

    expect(approval).not.toBeNull();
    expect(
      buildExecApprovalReplyPayload({
        details: {
          approvalId: "approval-1",
          approvalSlug: "slug-1",
          host: "gateway",
          command: "npm test",
        },
      }),
    ).toMatchObject({
      text: expect.stringContaining("/approve"),
    });
    expect(
      buildA2AApprovalReplyPayload({
        details: approval!,
      }),
    ).toMatchObject({
      text: expect.stringContaining("Permission required"),
    });
  });
});
