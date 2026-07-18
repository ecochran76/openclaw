# Slack Progress Mode Verbosity And Duplicate Updates

State: CLOSED
Created: 2026-04-23
Closed: 2026-04-23

## Summary

OpenClaw Slack progress streaming can be useful for long-running agent turns, but the current `progress` mode can produce excessive channel noise, duplicate edited tool blocks, and confusing post-final status/error messages.

## Bug Report Draft

Bug type: Behavior bug (incorrect output/state without crash)

Beta release blocker: No

Summary: With Slack configured for `channels.slack.streaming.mode="progress"` and `nativeTransport=true`, a tool-heavy turn emitted many separate `Working...` messages, duplicate tool summaries, large command-output fragments, a stalled-turn status, and post-final messages that conflicted with a successful visible final answer.

Steps to reproduce:

1. Configure Slack with:

```json
{
  "streaming": {
    "mode": "progress",
    "nativeTransport": true
  }
}
```

2. Run a Slack-triggered agent turn that reads several files, executes shell commands, applies a patch, and validates with long-running commands.
3. Observe Slack progress messages during the turn.

Expected behavior:

- Progress mode should expose useful during-turn status without overwhelming the channel.
- Tool progress should avoid duplicate near-identical edited blocks.
- Large command bodies and long output snippets should be summarized or truncated aggressively.
- Post-final status should not claim `turn finished but no visible reply was sent` when a visible final answer was delivered.
- Failed internal progress/tool rendering should not surface after a successful final answer unless it affected the task outcome.

Actual behavior observed:

- Slack showed many separate `Working...` messages for reads, plans, shell commands, process polling, and edits.
- Several tool blocks were duplicated before and after edit updates.
- Some progress entries included long inline heredoc command text and large JSON/config fragments.
- Slack showed `status: turn appears stalled` during an active turn.
- After a successful final answer, Slack also showed:

```text
:warning: :adhesive_bandage: Apply Patch failed
status: turn finished but no visible reply was sent
```

OpenClaw version: 2026.4.22

Operating system: Linux WSL2, Node 24.13.0

Install method: npm global install

Model: `openai-codex/gpt-5.4`

Provider / routing chain: OpenClaw Slack channel -> embedded runner -> `openai-codex` OAuth -> OpenAI Codex Responses API

Additional provider/model setup details:

- The affected agent had host tools enabled and executed a real multi-tool operational task.
- The verbosity appears tied to Slack progress transport/config, not a model verbosity flag.
- A separate config value, `session.agentToAgent.relay.verbosity="sender-message"`, exists but appears related to A2A relay behavior rather than Slack tool-progress rendering.

Impact and severity:

- Affected: Slack users watching tool-heavy OpenClaw agent turns in `progress` mode.
- Severity: Medium. The workflow can complete, but the channel becomes noisy and confusing.
- Frequency: Observed on a single long tool-heavy turn; likely reproducible with similar tool-heavy turns.
- Consequence: Users may mistake progress-rendering artifacts for task failures, especially when post-final warning/status messages contradict a successful answer.

## Source Areas To Inspect

- Slack native progress transport and message-edit aggregation.
- Tool-progress event coalescing for repeated `tool` / `exec` / `read` updates.
- Stalled-turn detector interaction with active tool calls or long-running process sessions.
- Final-delivery detector that emits `turn finished but no visible reply was sent`.
- Error routing for failed internal patch/progress render events after a successful final response.

## Acceptance Criteria

- Add a quieter progress mode or tune existing `progress` mode to coalesce duplicate tool updates. Done by retaining a bounded set of normalized progress lines and skipping repeats in `extensions/slack/src/monitor/message-handler/dispatch.ts`.
- Truncate command bodies and outputs in Slack progress updates by default. Done with a 120-character Slack preview progress line cap.
- Ensure final-delivery status reflects the actual visible final message state. Done by removing the fallback stranded notice for delivered states in `src/auto-reply/reply/dispatch-from-config.ts`.
- Ensure internal progress-render failures do not appear as task failures when final delivery succeeds. Reduced by keeping progress-mode boundaries in a single draft preview and avoiding post-delivery stranded notices; remaining true delivery failures still surface.
- Document Slack streaming modes and expected verbosity tradeoffs. Done in `docs/concepts/streaming.md`.

## Resolution

Slack `progress` mode now keeps tool-progress previews compact: progress lines are normalized, truncated, de-duplicated across the retained preview, and capped to four lines. Progress-mode draft boundaries no longer force new Slack messages, which keeps long turns in one edited preview instead of many separate `Working...` posts. The tracked-turn watcher now reports a long-running active tool as still running instead of surfacing a stalled-turn warning, and the older dispatch path no longer emits `turn finished but no visible reply was sent` after a visible final reply has already been delivered.

Validation:

```text
pnpm test src/agents/pi-embedded-runner/tool-split.test.ts extensions/slack/src/monitor/message-handler/dispatch.streaming.test.ts src/auto-reply/reply/delivery-observer.test.ts src/auto-reply/reply/dispatch-from-config.test.ts
```

Result: passed.
