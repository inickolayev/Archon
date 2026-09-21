---
title: Telegram
description: Connect Archon to Telegram using the Bot API for mobile and desktop access.
category: adapters
area: adapters
audience: [user, operator]
status: current
sidebar:
  order: 3
---

Connect Archon to Telegram so you can interact with your AI coding assistant from any Telegram client.

## Prerequisites

- Archon server running (see [Getting Started](/getting-started/overview/))
- A Telegram account

## Create Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token (format: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

## Set Environment Variable

```ini
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHI...
```

## Configure User Whitelist (Optional)

To restrict bot access to specific users:
1. Message [@userinfobot](https://t.me/userinfobot) on Telegram to get your user ID
2. Add to environment:

```ini
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
```

When set, only listed user IDs can interact with the bot. When empty/unset, the bot responds to all users.

## Configure Streaming Mode (Optional)

```ini
TELEGRAM_STREAMING_MODE=stream  # stream (default) | batch
```

For streaming mode details, see [Configuration](/getting-started/configuration/).

## The "agent is working" line

While a turn runs the bot keeps one transient message in the chat saying what the
agent is doing right now -- `⏳ Thinking…`, then `⏳ Reading adapter.ts…`,
`⏳ Running tests…` as the work moves on. It is posted the moment the turn starts,
rewritten in place, and deleted when the turn ends -- including when the turn is
called off with **⏹ Stop**.

It is chrome, not conversation: it is sent straight down the Bot API rather than
through the adapter's `sendMessage`, so it is never written to the conversation
history and never mirrored to the web console (which draws its own indicator).
The steps come from the same tool-call stream the console's trace is built from,
and the wording is chosen from the tool name -- a file's name may appear, an
absolute path never does.

```ini
TELEGRAM_STATUS_ENABLED=true       # false for silence until the answer lands
TELEGRAM_STATUS_THROTTLE_MS=3000   # shortest gap between rewrites (min 1000)
```

Telegram rate-limits edits and answers `400 message is not modified` when the text
has not changed. Both are treated as ordinary outcomes: identical text is never
re-sent, rewrites are throttled, and a failed update -- or a delete Telegram
refuses, which falls back to editing the line to `✓ Done.` -- can never fail the
turn it is decorating.

## Further Reading

- [Configuration](/getting-started/configuration/)
