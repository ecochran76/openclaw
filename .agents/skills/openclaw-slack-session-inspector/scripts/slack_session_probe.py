#!/usr/bin/env python3
"""Read-only Slack permalink to OpenClaw session correlation helper."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


@dataclass(frozen=True)
class SlackLink:
    url: str
    host: str
    channel_id: str
    raw_permalink_ts: str
    message_ts: str
    thread_ts: str | None


def parse_slack_link(value: str) -> SlackLink:
    parsed = urlparse(value)
    match = re.search(r"/archives/([^/]+)/p(\d{11,})", parsed.path)
    if not match:
        raise ValueError("expected Slack permalink with /archives/<channel>/p<timestamp>")

    raw_ts = match.group(2)
    if len(raw_ts) <= 6:
        raise ValueError(f"invalid Slack permalink timestamp: p{raw_ts}")

    message_ts = f"{raw_ts[:-6]}.{raw_ts[-6:]}"
    query = parse_qs(parsed.query)
    thread_ts = query.get("thread_ts", [None])[0]
    return SlackLink(
        url=value,
        host=parsed.netloc,
        channel_id=match.group(1),
        raw_permalink_ts=raw_ts,
        message_ts=message_ts,
        thread_ts=thread_ts,
    )


def run_json(cmd: list[str], timeout: int = 20) -> dict[str, Any] | None:
    try:
        proc = subprocess.run(
            cmd,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "error": str(exc), "command": cmd}

    if proc.returncode != 0:
        return {
            "ok": False,
            "returncode": proc.returncode,
            "stderr": proc.stderr.strip()[-2000:],
            "stdout": proc.stdout.strip()[-2000:],
            "command": cmd,
        }
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        return {
            "ok": False,
            "error": f"invalid JSON: {exc}",
            "stdout": proc.stdout.strip()[-2000:],
            "command": cmd,
        }
    if isinstance(data, dict):
        data.setdefault("ok", True)
        return data
    return {"ok": True, "data": data}


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def iter_session_stores(agents_root: Path, only_agent: str | None) -> list[tuple[str, Path]]:
    if only_agent:
        candidate = agents_root / only_agent / "sessions" / "sessions.json"
        return [(only_agent, candidate)] if candidate.exists() else []

    stores: list[tuple[str, Path]] = []
    if not agents_root.exists():
        return stores
    for path in sorted(agents_root.glob("*/sessions/sessions.json")):
        stores.append((path.parents[1].name, path))
    return stores


def as_entries(raw: Any) -> list[tuple[str | None, dict[str, Any]]]:
    if isinstance(raw, dict):
        return [(str(key), value) for key, value in raw.items() if isinstance(value, dict)]
    if isinstance(raw, list):
        return [(None, value) for value in raw if isinstance(value, dict)]
    return []


def text_preview(line: str, limit: int = 220) -> str:
    redacted = re.sub(r"([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+)", r"[email]@\2", line)
    redacted = re.sub(r"\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b", "[phone]", redacted)
    return redacted[:limit] + ("..." if len(redacted) > limit else "")


def raw_slack_ts(ts: str) -> str:
    return ts.replace(".", "")


def slack_ts_ms(ts: str) -> int | None:
    try:
        return int(float(ts) * 1000)
    except (TypeError, ValueError):
        return None


def extract_slack_messages(message_read: dict[str, Any] | None) -> list[dict[str, Any]]:
    payload = message_read.get("payload") if isinstance(message_read, dict) else None
    messages = payload.get("messages") if isinstance(payload, dict) else None
    if not isinstance(messages, list):
        return []
    return [message for message in messages if isinstance(message, dict)]


def summarize_slack_message(message: dict[str, Any]) -> dict[str, Any]:
    text = str(message.get("text") or "")
    return {
        "ts": message.get("ts"),
        "threadTs": message.get("thread_ts"),
        "user": message.get("user"),
        "botId": message.get("bot_id"),
        "timestampUtc": message.get("timestampUtc"),
        "replyCount": message.get("reply_count"),
        "preview": text_preview(text, 180),
    }


def related_slack_messages(link: SlackLink, message_read: dict[str, Any] | None) -> dict[str, Any]:
    messages = extract_slack_messages(message_read)
    linked = next((message for message in messages if message.get("ts") == link.message_ts), None)
    thread_root = None
    if link.thread_ts:
        thread_root = next((message for message in messages if message.get("ts") == link.thread_ts), None)

    linked_ms = slack_ts_ms(link.message_ts)
    nearby_user_prompts: list[dict[str, Any]] = []
    for message in messages:
        ts = message.get("ts")
        ts_ms = slack_ts_ms(str(ts)) if ts else None
        if ts_ms is None or linked_ms is None:
            continue
        if ts == link.message_ts:
            continue
        # Slack links to OpenClaw's first progress/thread-root message often
        # need the immediately preceding human prompt to explain the run.
        if linked_ms - 15_000 <= ts_ms <= linked_ms + 2_000 and not message.get("bot_id"):
            nearby_user_prompts.append(summarize_slack_message(message))

    return {
        "linkedMessage": summarize_slack_message(linked) if linked else None,
        "threadRoot": summarize_slack_message(thread_root) if thread_root else None,
        "nearbyUserPrompts": nearby_user_prompts,
    }


def related_needles(link: SlackLink, related: dict[str, Any] | None) -> set[str]:
    needles = {link.message_ts, link.raw_permalink_ts}
    if link.thread_ts:
        needles.add(link.thread_ts)
        needles.add(raw_slack_ts(link.thread_ts))
    if not related:
        return needles
    for key in ("linkedMessage", "threadRoot"):
        value = related.get(key)
        if isinstance(value, dict) and value.get("ts"):
            ts = str(value["ts"])
            needles.add(ts)
            needles.add(raw_slack_ts(ts))
    for value in related.get("nearbyUserPrompts") or []:
        if isinstance(value, dict) and value.get("ts"):
            ts = str(value["ts"])
            needles.add(ts)
            needles.add(raw_slack_ts(ts))
    return needles


def summarize_trajectory(path: Path) -> dict[str, Any] | None:
    trajectory = path
    if not path.name.endswith(".trajectory.jsonl"):
        if path.name.endswith(".jsonl"):
            trajectory = path.with_name(path.name[:-6] + ".trajectory.jsonl")
        else:
            return None
    if not trajectory.exists():
        return {"path": str(trajectory), "exists": False}

    runs: dict[str, dict[str, Any]] = {}
    event_counts: dict[str, int] = {}
    try:
        lines = trajectory.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError as exc:
        return {"path": str(trajectory), "exists": False, "error": str(exc)}

    for line in lines:
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        event = str(obj.get("type") or "<unknown>")
        event_counts[event] = event_counts.get(event, 0) + 1
        run_id = obj.get("runId")
        if not run_id:
            continue
        run = runs.setdefault(
            str(run_id),
            {
                "runId": str(run_id),
                "started": False,
                "completed": False,
                "ended": False,
                "finalStatus": None,
                "startedAt": None,
                "endedAt": None,
            },
        )
        if event == "session.started":
            run["started"] = True
            run["startedAt"] = obj.get("ts")
        elif event == "model.completed":
            run["completed"] = True
        elif event == "trace.artifacts":
            data = obj.get("data") if isinstance(obj.get("data"), dict) else {}
            run["finalStatus"] = data.get("finalStatus")
        elif event == "session.ended":
            run["ended"] = True
            run["endedAt"] = obj.get("ts")

    incomplete = [
        {
            "runId": run["runId"],
            "started": run["started"],
            "completed": run["completed"],
            "ended": run["ended"],
            "startedAt": run["startedAt"],
            "endedAt": run["endedAt"],
            "finalStatus": run["finalStatus"],
        }
        for run in runs.values()
        if run["started"] and not run["ended"]
    ]
    return {
        "path": str(trajectory),
        "exists": True,
        "bytes": trajectory.stat().st_size,
        "eventCounts": event_counts,
        "runCount": len(runs),
        "incompleteRuns": incomplete[:10],
    }


def score_entry(
    entry_key: str | None,
    entry: dict[str, Any],
    link: SlackLink,
    account: str | None,
) -> tuple[int, list[str]]:
    score = 0
    reasons: list[str] = []
    channel_target = f"channel:{link.channel_id}".lower()
    channel_id = link.channel_id.lower()
    thread_candidates = {link.message_ts}
    if link.thread_ts:
        thread_candidates.add(link.thread_ts)

    serialized_key = (entry_key or "").lower()
    if channel_id in serialized_key:
        score += 20
        reasons.append("session key contains channel id")
    for ts in thread_candidates:
        if ts and ts in serialized_key:
            score += 40
            reasons.append("session key contains thread/message timestamp")

    delivery = entry.get("deliveryContext") if isinstance(entry.get("deliveryContext"), dict) else {}
    origin = entry.get("origin") if isinstance(entry.get("origin"), dict) else {}
    fields = {
        "channel": entry.get("channel") or delivery.get("channel") or origin.get("provider"),
        "to": entry.get("lastTo") or delivery.get("to") or origin.get("to"),
        "account": entry.get("lastAccountId") or delivery.get("accountId") or origin.get("accountId"),
        "thread": entry.get("lastThreadId") or delivery.get("threadId") or origin.get("threadId"),
        "group": entry.get("groupId") or origin.get("nativeChannelId"),
    }

    if str(fields["channel"]).lower() == "slack":
        score += 10
        reasons.append("slack session")
    if str(fields["to"]).lower() == channel_target or str(fields["group"]).lower() == channel_id:
        score += 30
        reasons.append("channel target matches")
    if account and str(fields["account"]).lower() == account.lower():
        score += 15
        reasons.append("account matches")
    if fields["thread"] and str(fields["thread"]) in thread_candidates:
        score += 50
        reasons.append("thread id matches")

    updated_at = entry.get("updatedAt")
    if isinstance(updated_at, (int, float)):
        message_ms = int(float(link.message_ts) * 1000)
        if message_ms - 300_000 <= int(updated_at) <= message_ms + 86_400_000:
            score += 5
            reasons.append("updated near/after message timestamp")

    return score, reasons


def scan_file(path: Path, needles: set[str], include_snippets: bool) -> dict[str, Any] | None:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None

    hits = [needle for needle in needles if needle and needle in text]
    if not hits:
        return None

    result: dict[str, Any] = {
        "path": str(path),
        "hits": sorted(hits),
        "bytes": path.stat().st_size,
    }
    if include_snippets:
        snippets: list[str] = []
        for line in text.splitlines():
            if any(needle in line for needle in hits):
                snippets.append(text_preview(line))
            if len(snippets) >= 5:
                break
        result["snippets"] = snippets
    return result


def collect_sessions(
    link: SlackLink,
    account: str | None,
    agents_root: Path,
    only_agent: str | None,
    include_snippets: bool,
    needles: set[str],
) -> dict[str, Any]:
    stores = iter_session_stores(agents_root, only_agent)
    session_matches: list[dict[str, Any]] = []
    file_matches: list[dict[str, Any]] = []

    for agent_id, store_path in stores:
        try:
            entries = as_entries(load_json(store_path))
        except (OSError, json.JSONDecodeError) as exc:
            session_matches.append(
                {
                    "agentId": agent_id,
                    "storePath": str(store_path),
                    "error": str(exc),
                }
            )
            continue

        for entry_key, entry in entries:
            score, reasons = score_entry(entry_key, entry, link, account)
            if score <= 0:
                continue
            session_matches.append(
                {
                    "agentId": agent_id,
                    "key": entry_key,
                    "score": score,
                    "reasons": reasons,
                    "sessionId": entry.get("sessionId"),
                    "sessionFile": entry.get("sessionFile"),
                    "updatedAt": entry.get("updatedAt"),
                    "displayName": entry.get("displayName"),
                    "deliveryContext": entry.get("deliveryContext"),
                    "lastThreadId": entry.get("lastThreadId"),
                    "lastAccountId": entry.get("lastAccountId"),
                }
            )

        sessions_dir = store_path.parent
        for path in sorted(sessions_dir.glob("*.jsonl")):
            hit = scan_file(path, needles, include_snippets)
            if hit:
                hit["agentId"] = agent_id
                hit["trajectorySummary"] = summarize_trajectory(path)
                file_matches.append(hit)

    session_matches.sort(key=lambda item: item.get("score", 0), reverse=True)
    file_matches.sort(key=lambda item: (item.get("agentId", ""), item.get("path", "")))
    return {
        "storesScanned": len(stores),
        "sessionMatches": session_matches[:25],
        "fileMatches": file_matches[:50],
    }


def build_cli_probes(link: SlackLink, account: str) -> dict[str, Any]:
    target = f"channel:{link.channel_id}"
    return {
        "messageRead": run_json(
            [
                "openclaw",
                "message",
                "read",
                "--channel",
                "slack",
                "--account",
                account,
                "--target",
                target,
                "--around",
                link.message_ts,
                "--limit",
                "10",
                "--json",
            ]
        ),
        "whySilent": run_json(
            [
                "openclaw",
                "channels",
                "why-silent",
                "--channel",
                "slack",
                "--account",
                account,
                "--target",
                target,
                "--limit",
                "10",
                "--json",
            ]
        ),
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("slack_link", help="Slack permalink")
    parser.add_argument("--account", help="Slack account id, for example default or soylei")
    parser.add_argument("--agent", help="Limit disk scan to one agent id")
    parser.add_argument(
        "--agents-root",
        default=str(Path.home() / ".openclaw" / "agents"),
        help="OpenClaw agents root",
    )
    parser.add_argument("--no-cli", action="store_true", help="Skip live OpenClaw CLI probes")
    parser.add_argument("--snippets", action="store_true", help="Include redacted matching JSONL snippets")
    parser.add_argument("--json", action="store_true", help="Print JSON output")
    args = parser.parse_args(argv)

    try:
        link = parse_slack_link(args.slack_link)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    agents_root = Path(os.path.expanduser(args.agents_root)).resolve()
    cli: dict[str, Any] | None
    if not args.no_cli:
        if args.account:
            cli = build_cli_probes(link, args.account)
        else:
            cli = {
                "ok": False,
                "error": "skipped live CLI probes because --account was not provided",
            }
    else:
        cli = None

    related = related_slack_messages(link, cli.get("messageRead") if cli else None)
    needles = related_needles(link, related)
    result: dict[str, Any] = {
        "parsed": {
            "host": link.host,
            "channelId": link.channel_id,
            "messageTs": link.message_ts,
            "rawPermalinkTs": link.raw_permalink_ts,
            "threadTs": link.thread_ts,
            "target": f"channel:{link.channel_id}",
        },
        "account": args.account,
        "relatedSlackMessages": related,
        "cli": cli,
        "disk": collect_sessions(
            link,
            args.account,
            agents_root,
            args.agent,
            args.snippets,
            needles,
        ),
    }

    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(f"Slack: channel={link.channel_id} message_ts={link.message_ts} thread_ts={link.thread_ts or '-'}")
        if args.account:
            print(f"Account: {args.account}")
        if related.get("nearbyUserPrompts"):
            print("Nearby user prompt candidates:")
            for message in related["nearbyUserPrompts"]:
                print(f"- {message.get('ts')} {message.get('user')}: {message.get('preview')}")
        disk = result["disk"]
        print(f"Session stores scanned: {disk['storesScanned']}")
        print(f"Session matches: {len(disk['sessionMatches'])}")
        for item in disk["sessionMatches"][:10]:
            print(
                f"- score={item['score']} agent={item.get('agentId')} key={item.get('key')} "
                f"sessionFile={item.get('sessionFile')}"
            )
            print(f"  reasons: {', '.join(item.get('reasons') or [])}")
        print(f"Transcript/trajectory file matches: {len(disk['fileMatches'])}")
        for item in disk["fileMatches"][:10]:
            print(f"- agent={item.get('agentId')} path={item.get('path')} hits={','.join(item.get('hits') or [])}")
            summary = item.get("trajectorySummary")
            if isinstance(summary, dict) and summary.get("incompleteRuns"):
                print(f"  incomplete trajectory runs: {len(summary['incompleteRuns'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
