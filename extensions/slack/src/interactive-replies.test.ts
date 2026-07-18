// Slack tests cover interactive replies plugin behavior.
import { describe, expect, it } from "vitest";
import {
  compileSlackA2AApprovalInteractive,
  compileSlackInteractiveReplies,
} from "./interactive-replies.js";

describe("compileSlackInteractiveReplies", () => {
  it("renders A2A approval metadata as Slack-owned interactive buttons", () => {
    const result = compileSlackA2AApprovalInteractive({
      text: "Permission required",
      channelData: {
        a2aApproval: {
          approvalId: "approval-123",
        },
      },
    });

    expect(result.interactive).toEqual({
      blocks: [
        { type: "text", text: "Permission required" },
        {
          type: "buttons",
          buttons: [
            {
              label: "Approve",
              value: "a2aapproval:approval-123:a",
              style: "success",
            },
            {
              label: "Deny",
              value: "a2aapproval:approval-123:d",
              style: "danger",
            },
          ],
        },
      ],
    });
  });

  it("compiles inline Slack button directives into shared interactive blocks", () => {
    const result = compileSlackInteractiveReplies({
      text: "[bot] hello [[slack_buttons: Retry:retry, Ignore:ignore]]",
    });

    expect(result.text).toBe("[bot] hello");
    expect(result.interactive).toEqual({
      blocks: [
        {
          type: "text",
          text: "[bot] hello",
        },
        {
          type: "buttons",
          buttons: [
            {
              label: "Retry",
              value: "retry",
            },
            {
              label: "Ignore",
              value: "ignore",
            },
          ],
        },
      ],
    });
  });

  it("combines A2A approval and legacy buttons without exposing the directive", () => {
    const result = compileSlackInteractiveReplies({
      text: "Permission required [[slack_buttons: Retry:retry, Ignore:ignore]]",
      channelData: {
        a2aApproval: {
          approvalId: "approval-123",
        },
      },
    });

    expect(result.text).toBe("Permission required");
    expect(result.interactive).toEqual({
      blocks: [
        { type: "text", text: "Permission required" },
        {
          type: "buttons",
          buttons: [
            { label: "Retry", value: "retry" },
            { label: "Ignore", value: "ignore" },
          ],
        },
        {
          type: "buttons",
          buttons: [
            { label: "Approve", value: "a2aapproval:approval-123:a", style: "success" },
            { label: "Deny", value: "a2aapproval:approval-123:d", style: "danger" },
          ],
        },
      ],
    });
    expect(JSON.stringify(result.interactive)).not.toContain("[[slack_buttons");
  });

  it("compiles simple trailing Options lines into Slack buttons", () => {
    const result = compileSlackInteractiveReplies({
      text: "Current verbose level: off.\nOptions: on, full, off.",
    });

    expect(result.text).toBe("Current verbose level: off.");
    expect(result.interactive).toEqual({
      blocks: [
        {
          type: "text",
          text: "Current verbose level: off.",
        },
        {
          type: "buttons",
          buttons: [
            { label: "on", value: "on" },
            { label: "full", value: "full" },
            { label: "off", value: "off" },
          ],
        },
      ],
    });
  });

  it("combines A2A approval and trailing Options without exposing the options line", () => {
    const result = compileSlackInteractiveReplies({
      text: "Permission required\nOptions: retry, ignore.",
      channelData: {
        a2aApproval: {
          approvalId: "approval-123",
        },
      },
    });

    expect(result.text).toBe("Permission required");
    expect(result.interactive?.blocks).toEqual([
      { type: "text", text: "Permission required" },
      {
        type: "buttons",
        buttons: [
          { label: "retry", value: "retry" },
          { label: "ignore", value: "ignore" },
        ],
      },
      {
        type: "buttons",
        buttons: [
          { label: "Approve", value: "a2aapproval:approval-123:a", style: "success" },
          { label: "Deny", value: "a2aapproval:approval-123:d", style: "danger" },
        ],
      },
    ]);
    expect(JSON.stringify(result.interactive)).not.toContain("Options:");
  });

  it("uses a Slack select when Options lines exceed button capacity", () => {
    const result = compileSlackInteractiveReplies({
      text: "Choose a reasoning level.\nOptions: off, minimal, low, medium, high, adaptive.",
    });

    expect(result.text).toBe("Choose a reasoning level.");
    expect(result.interactive).toEqual({
      blocks: [
        {
          type: "text",
          text: "Choose a reasoning level.",
        },
        {
          type: "select",
          placeholder: "Choose an option",
          options: [
            { label: "off", value: "off" },
            { label: "minimal", value: "minimal" },
            { label: "low", value: "low" },
            { label: "medium", value: "medium" },
            { label: "high", value: "high" },
            { label: "adaptive", value: "adaptive" },
          ],
        },
      ],
    });
  });

  it("leaves complex Options lines as plain text", () => {
    const result = compileSlackInteractiveReplies({
      text: "ACP runtime choices.\nOptions: host=auto|sandbox|gateway|node, security=deny|allowlist|full.",
    });

    expect(result.text).toBe(
      "ACP runtime choices.\nOptions: host=auto|sandbox|gateway|node, security=deny|allowlist|full.",
    );
    expect(result.interactive).toBeUndefined();
  });

  it("keeps time-style colons in Slack button labels", () => {
    const result = compileSlackInteractiveReplies({
      text: "[[slack_buttons: Fr 10.07. 9:00:slot_fr_0900, Mo 13.07. 10:45:slot_mo_1045, Today 11:30:ticket:123, Mon 14:30-16:00:slot_range]]",
    });

    expect(result.interactive).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Fr 10.07. 9:00", value: "slot_fr_0900" },
            { label: "Mo 13.07. 10:45", value: "slot_mo_1045" },
            { label: "Today 11:30", value: "ticket:123" },
            { label: "Mon 14:30-16:00", value: "slot_range" },
          ],
        },
      ],
    });
  });

  it("keeps button style suffixes after time-style labels", () => {
    const result = compileSlackInteractiveReplies({
      text: "[[slack_buttons: Fr 10.07. 9:00:slot_fr_0900:primary, Later 10:45:slot_later:danger]]",
    });

    expect(result.interactive).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Fr 10.07. 9:00", value: "slot_fr_0900", style: "primary" },
            { label: "Later 10:45", value: "slot_later", style: "danger" },
          ],
        },
      ],
    });
  });

  it("preserves colon-containing Slack callback values", () => {
    const result = compileSlackInteractiveReplies({
      text: "[[slack_buttons: Model v2:01:open, Step 2:30-day:open, Timed:ticket:9:00:id, Today 11:30:12:34:id, Deny:/approve plugin:approval-123 deny]]",
    });

    expect(result.interactive).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Model v2", value: "01:open" },
            { label: "Step 2", value: "30-day:open" },
            { label: "Timed", value: "ticket:9:00:id" },
            { label: "Today 11:30", value: "12:34:id" },
            { label: "Deny", value: "/approve plugin:approval-123 deny" },
          ],
        },
      ],
    });
  });

  it("keeps single-colon button entries unchanged when the value matches a style name", () => {
    const result = compileSlackInteractiveReplies({
      text: "[[slack_buttons: Primary:primary, Danger:danger, Fr 10.07. 9:00:primary]]",
    });

    expect(result.interactive).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Primary", value: "primary" },
            { label: "Danger", value: "danger" },
            { label: "Fr 10.07. 9:00", value: "primary" },
          ],
        },
      ],
    });
  });

  it("keeps time-style colons in Slack select option labels", () => {
    const result = compileSlackInteractiveReplies({
      text: "[[slack_select: Pick a time | Fr 10.07. 9:00:slot_fr_0900, Mo 13.07. 10:45:slot_mo_1045]]",
    });

    expect(result.interactive).toEqual({
      blocks: [
        {
          type: "select",
          placeholder: "Pick a time",
          options: [
            { label: "Fr 10.07. 9:00", value: "slot_fr_0900" },
            { label: "Mo 13.07. 10:45", value: "slot_mo_1045" },
          ],
        },
      ],
    });
  });
});
