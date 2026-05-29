// Commander registration for channel discovery, setup, status, auth, and diagnostics commands.
import type { Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { runChannelLogin, runChannelLogout } from "./channel-auth.js";
import { formatCliChannelOptions } from "./channel-options.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { hasExplicitOptions } from "./command-options.js";
import { formatHelpExamples } from "./help-format.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";
import { normalizeWindowsArgv } from "./windows-argv.js";

type ChannelsCommandsModule = typeof import("../commands/channels.js");
type BundledPackageChannelMetadataModule =
  typeof import("../plugins/bundled-package-channel-metadata.js");

const optionNamesRemove = ["channel", "account", "delete"] as const;

type RegisterChannelsCliOptions = {
  includeSetupOptions?: boolean;
};

const channelsCommandsLoader = createLazyImportLoader<ChannelsCommandsModule>(
  () => import("../commands/channels.js"),
);
const bundledPackageChannelMetadataLoader =
  createLazyImportLoader<BundledPackageChannelMetadataModule>(
    () => import("../plugins/bundled-package-channel-metadata.js"),
  );

function loadChannelsCommands(): Promise<ChannelsCommandsModule> {
  return channelsCommandsLoader.load();
}

function runChannelsCommand(action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action);
}

function runChannelsCommandWithDanger(action: () => Promise<void>, label: string) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    defaultRuntime.error(danger(`${label}: ${String(err)}`));
    defaultRuntime.exit(1);
  });
}

function getOptionNames(command: Command): string[] {
  return command.options.map((option) => option.attributeName());
}

function shouldRegisterChannelSetupOptions(
  argv: string[] = process.argv,
  options: RegisterChannelsCliOptions = {},
): boolean {
  // Channel-specific setup flags are expensive to load and only needed on `channels add`.
  if (options.includeSetupOptions) {
    return true;
  }
  const { commandPath } = resolveCliArgvInvocation(normalizeWindowsArgv(argv));
  return commandPath[0] === "channels" && commandPath[1] === "add";
}

async function addChannelSetupOptions(command: Command): Promise<Command> {
  const { listBundledPackageChannelMetadata } = await bundledPackageChannelMetadataLoader.load();
  const seenFlags = new Set(command.options.map((option) => option.flags));
  const channels = listBundledPackageChannelMetadata().toSorted((left, right) => {
    const leftOrder = left.order ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.order ?? Number.MAX_SAFE_INTEGER;
    return leftOrder === rightOrder
      ? (left.id ?? "").localeCompare(right.id ?? "")
      : leftOrder - rightOrder;
  });
  for (const channel of channels) {
    for (const option of channel.cliAddOptions ?? []) {
      if (seenFlags.has(option.flags)) {
        continue;
      }
      seenFlags.add(option.flags);
      if (option.defaultValue !== undefined) {
        command.option(option.flags, option.description, option.defaultValue);
      } else {
        command.option(option.flags, option.description);
      }
    }
  }
  return command;
}

export async function registerChannelsCli(
  program: Command,
  argv: string[] = process.argv,
  options: RegisterChannelsCliOptions = {},
) {
  const channelNames = formatCliChannelOptions();
  const channels = program
    .command("channels")
    .description("Manage connected chat channels and accounts")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw channels list", "List configured channels."],
          ["openclaw channels list --all", "Show configured, bundled, and installable channels."],
          ["openclaw channels add", "Open guided channel setup."],
          ["openclaw channels status --probe", "Run channel status checks and probes."],
          [
            "openclaw channels why-silent --channel slack --account soylei --target channel:C123",
            "Compare recent channel history with OpenClaw inbound activity.",
          ],
          [
            "openclaw channels inspect-link https://example.slack.com/archives/C123/p1778009972917279 --account soylei",
            "Correlate a Slack permalink with OpenClaw sessions and trajectories.",
          ],
          [
            "openclaw channels watchdog-scan --account soylei --target channel:C123 --since 30m",
            "Scan recent Slack history for messages missing OpenClaw admission records.",
          ],
          [
            "openclaw channels watchdog-scan --account soylei --permalink https://example.slack.com/archives/C123/p1779309189369149",
            "Run a permalink-anchored post-mortem scan around one Slack message.",
          ],
          [
            "openclaw channels watchdog-status --account soylei",
            "Summarize watchdog alert, source-reply, and recovery state.",
          ],
          [
            "openclaw channels watchdog-replay --account soylei --permalink https://example.slack.com/archives/C123/p1779309189369149",
            "Preflight a guarded recovery turn for one missed Slack message.",
          ],
          [
            "openclaw channels add --channel telegram --token <token>",
            "Add or update a channel account non-interactively.",
          ],
          ["openclaw channels login --channel whatsapp", "Link a WhatsApp Web account."],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink(
          "/cli/channels",
          "docs.openclaw.ai/cli/channels",
        )}\n`,
    );

  channels
    .command("list")
    .description("List chat channels (configured by default; pass --all for installable catalog)")
    .option("--all", "Include bundled and installable catalog channels", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runChannelsCommand(async () => {
        const { channelsListCommand } = await import("../commands/channels/list.js");
        await channelsListCommand(opts, defaultRuntime);
      });
    });

  channels
    .command("status")
    .description("Show gateway channel status (use status --deep for local)")
    .option("--channel <name>", `Only show one channel (${formatCliChannelOptions(["all"])})`)
    .option("--probe", "Probe channel credentials", false)
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runChannelsCommand(async () => {
        const { channelsStatusCommand } = await import("../commands/channels/status.js");
        await channelsStatusCommand(opts, defaultRuntime);
      });
    });

  channels
    .command("why-silent")
    .description("Diagnose why a channel message did not produce an OpenClaw reply")
    .option("--channel <name>", `Channel (${channelNames})`, "slack")
    .option("--account <id>", "Channel account id", "default")
    .requiredOption("--target <dest>", "Channel target (for example channel:C123)")
    .option("--limit <n>", "Recent messages to read", "5")
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runChannelsCommand(async () => {
        const { channelsWhySilentCommand } = await import("../commands/channels/why-silent.js");
        await channelsWhySilentCommand(opts, defaultRuntime);
      });
    });

  channels
    .command("inspect-link")
    .description("Inspect OpenClaw sessions associated with a Slack permalink")
    .argument("<permalink>", "Slack permalink")
    .option("--account <id>", "Slack account id", "default")
    .option("--agent <id>", "Limit session-store scan to one agent")
    .option("--limit <n>", "Messages to read around the permalink", "10")
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .option("--json", "Output JSON", false)
    .action(async (permalink, opts) => {
      await runChannelsCommand(async () => {
        const { channelsInspectLinkCommand } = await loadChannelsCommands();
        await channelsInspectLinkCommand(String(permalink), opts, defaultRuntime);
      });
    });

  channels
    .command("watchdog-scan")
    .description("Read-only Slack admission-gap scan for stale socket detection")
    .option("--account <id>", "Slack account id", "default")
    .option("--tenant-label <label>", "Human Slack tenant/workspace label for reports")
    .option("--target <dest>", "Slack target (for example channel:C123 or D123)")
    .option("--permalink <url>", "Slack permalink to derive target and anchor the scan window")
    .option("--channel-name <name>", "Human Slack channel name for reports")
    .option("--limit <n>", "Recent Slack messages to read", "50")
    .option("--since <duration>", "History window to scan (for example 30m, 2h)", "30m")
    .option("--bot-user <id>", "Slack bot user id for mention-based relevance checks")
    .option("--direct-message", "Treat target as a DM even if the id does not start with D", false)
    .option(
      "--active-thread <ts,csv>",
      "Comma-separated active thread timestamps to treat as relevant",
    )
    .option("--thread <ts>", "Read and scan replies from one Slack thread timestamp")
    .option("--alert-target <dest>", "Post a deduped alert when missing admissions are found")
    .option("--alert-account <id>", "Slack account id used for watchdog alerts", "default")
    .option("--alert-state <path>", "Override alert dedupe state JSON path")
    .option("--reply-missed", "Post one deduped thread reply on missed source messages", false)
    .option("--reply-account <id>", "Slack account id used for missed-message replies")
    .option("--reply-state <path>", "Override missed-message reply dedupe state JSON path")
    .option("--dry-run-replies", "Render planned missed-message replies without sending", false)
    .option("--max-replies <n>", "Maximum missed-message replies to send per scan", "3")
    .option("--ledger-limit <n>", "Recent admission ledger rows to read", "5000")
    .option("--timeout <ms>", "Gateway read timeout in ms", "10000")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runChannelsCommand(async () => {
        const { channelsSlackWatchdogScanCommand } =
          await import("../commands/channels/slack-watchdog-scan.js");
        await channelsSlackWatchdogScanCommand(opts, defaultRuntime);
      });
    });

  channels
    .command("watchdog-status")
    .description("Summarize Slack watchdog alert, reply, and recovery state")
    .option("--account <id>", "Slack account id", "default")
    .option("--state <path>", "Override watchdog state JSON path")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runChannelsCommand(async () => {
        const { channelsSlackWatchdogStatusCommand } =
          await import("../commands/channels/slack-watchdog-scan.js");
        await channelsSlackWatchdogStatusCommand(opts, defaultRuntime);
      });
    });

  channels
    .command("watchdog-replay")
    .description("Guarded recovery for one Slack message missing an admission record")
    .option("--account <id>", "Slack account id", "default")
    .option("--target <dest>", "Slack target (for example channel:C123 or D123)")
    .option("--permalink <url>", "Slack permalink to derive target and message timestamp")
    .option("--ts <ts>", "Slack message timestamp to replay")
    .option("--thread <ts>", "Read the message from one Slack thread timestamp")
    .option("--since <duration>", "History window to search (for example 30m, 24h)", "24h")
    .option("--limit <n>", "Recent Slack messages to read while finding --ts", "100")
    .option("--bot-user <id>", "Slack bot user id for mention-based relevance checks")
    .option("--direct-message", "Treat target as a DM even if the id does not start with D", false)
    .option(
      "--active-thread <ts,csv>",
      "Comma-separated active thread timestamps to treat as relevant",
    )
    .option("--agent <id>", "Agent id to replay through (defaults to route/default agent)")
    .option("--state <path>", "Override watchdog recovery state JSON path")
    .option("--ledger-limit <n>", "Recent admission ledger rows to read", "5000")
    .option("--timeout <ms>", "Gateway/agent timeout in ms", "30000")
    .option("--execute", "Start the guarded agent turn after all replay checks pass", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runChannelsCommand(async () => {
        const { channelsSlackWatchdogReplayCommand } =
          await import("../commands/channels/slack-watchdog-scan.js");
        await channelsSlackWatchdogReplayCommand(opts, defaultRuntime);
      });
    });

  channels
    .command("capabilities")
    .description("Show provider capabilities (intents/scopes + supported features)")
    .option("--channel <name>", `Channel (${formatCliChannelOptions(["all"])})`)
    .option("--account <id>", "Account id (only with --channel)")
    .option("--target <dest>", "Channel target for permission audit (Discord channel:<id>)")
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runChannelsCommand(async () => {
        const { channelsCapabilitiesCommand } = await loadChannelsCommands();
        await channelsCapabilitiesCommand(opts, defaultRuntime);
      });
    });

  channels
    .command("resolve")
    .description("Resolve channel/user names to IDs")
    .argument("<entries...>", "Entries to resolve (names or ids)")
    .option("--channel <name>", `Channel (${channelNames})`)
    .option("--account <id>", "Account id (accountId)")
    .option("--kind <kind>", "Target kind (auto|user|group)", "auto")
    .option("--json", "Output JSON", false)
    .action(async (entries, opts) => {
      await runChannelsCommand(async () => {
        const { channelsResolveCommand } = await loadChannelsCommands();
        await channelsResolveCommand(
          {
            channel: opts.channel as string | undefined,
            account: opts.account as string | undefined,
            kind: opts.kind as "auto" | "user" | "group",
            json: Boolean(opts.json),
            entries: Array.isArray(entries) ? entries : [String(entries)],
          },
          defaultRuntime,
        );
      });
    });

  channels
    .command("logs")
    .description("Show recent channel logs from the gateway log file")
    .option("--channel <name>", `Channel (${formatCliChannelOptions(["all"])})`, "all")
    .option("--lines <n>", "Number of lines (default: 200)", "200")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runChannelsCommand(async () => {
        const { channelsLogsCommand } = await loadChannelsCommands();
        await channelsLogsCommand(opts, defaultRuntime);
      });
    });

  const addCommand = channels
    .command("add")
    .description("Add or update a channel account")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw channels add", "Open guided setup for available chat channels."],
          [
            "openclaw channels add --channel telegram --token <token>",
            "Add or update Telegram non-interactively.",
          ],
          ["openclaw channels list --all", "Find channel ids before using --channel."],
        ])}\n`,
    )
    .option("--channel <name>", `Channel (${channelNames})`)
    .option("--account <id>", "Account id (default when omitted)")
    .option("--name <name>", "Display name for this account")
    .option("--token <token>", "Channel token or credential payload")
    .option("--token-file <path>", "Read channel token or credential payload from file")
    .option("--secret <secret>", "Channel shared secret")
    .option("--secret-file <path>", "Read channel shared secret from file")
    .option("--bot-token <token>", "Bot token")
    .option("--app-token <token>", "App token")
    .option("--password <password>", "Channel password or login secret")
    .option("--cli-path <path>", "Channel CLI path")
    .option("--url <url>", "Channel setup URL")
    .option("--base-url <url>", "Channel base URL")
    .option("--http-url <url>", "Channel HTTP service URL")
    .option("--auth-dir <path>", "Channel auth directory override")
    .option("--use-env", "Use env-backed credentials when supported", false);

  if (shouldRegisterChannelSetupOptions(argv, options)) {
    await addChannelSetupOptions(addCommand);
  }

  addCommand.action(async (opts, command) => {
    await runChannelsCommand(async () => {
      const { channelsAddCommand } = await loadChannelsCommands();
      const hasFlags = hasExplicitOptions(command, getOptionNames(command));
      await channelsAddCommand(opts, defaultRuntime, { hasFlags });
    });
  });

  channels
    .command("remove")
    .description("Disable or delete a channel account")
    .option("--channel <name>", `Channel (${channelNames})`)
    .option("--account <id>", "Account id (default when omitted)")
    .option("--delete", "Delete config entries (no prompt)", false)
    .action(async (opts, command) => {
      await runChannelsCommand(async () => {
        const { channelsRemoveCommand } = await loadChannelsCommands();
        const hasFlags = hasExplicitOptions(command, optionNamesRemove);
        await channelsRemoveCommand(opts, defaultRuntime, { hasFlags });
      });
    });

  channels
    .command("login")
    .description("Link a channel account (if supported)")
    .option("--channel <channel>", "Channel alias (auto when only one is configured)")
    .option("--account <id>", "Account id (accountId)")
    .option("--verbose", "Verbose connection logs", false)
    .action(async (opts) => {
      await runChannelsCommandWithDanger(async () => {
        await runChannelLogin(
          {
            channel: opts.channel as string | undefined,
            account: opts.account as string | undefined,
            verbose: Boolean(opts.verbose),
          },
          defaultRuntime,
        );
      }, "Channel login failed");
    });

  channels
    .command("logout")
    .description("Log out of a channel session (if supported)")
    .option("--channel <channel>", "Channel alias (auto when only one is configured)")
    .option("--account <id>", "Account id (accountId)")
    .action(async (opts) => {
      await runChannelsCommandWithDanger(async () => {
        await runChannelLogout(
          {
            channel: opts.channel as string | undefined,
            account: opts.account as string | undefined,
          },
          defaultRuntime,
        );
      }, "Channel logout failed");
    });

  applyParentDefaultHelpAction(channels);
}
