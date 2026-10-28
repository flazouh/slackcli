# Changelog

This file records user-visible package changes.

## Unreleased

- Add `editedAt` to message rows (`read`, `thread`, `mentions`, `inbox`, `since`) when a person edited the message. `search` rows have none, because Slack's search results do not carry it. Text output prints `(edited HH:MM)` next to the time. Slack gives no edit time for a bot that rewrites its own message.
- `since` returns messages edited inside the window, not only those posted in it. It reads conversations from `--lookback` (default `6h`) before the window to find them, and reads a busy thread past its first 200 replies.

- `read` pages back through `conversations.history` until it has `-n` messages or the conversation has no more. It used to stop at the first screen, about 100 messages.
- Add `dms` to list your direct and group DMs with the conversation id that `read` takes.
- Add `edit` to update one of your own messages.
- Add a `files` array to every message row. A file-only message names its files instead of "Open in Slack for message text."
- Add `file` to download a file, with `--text` for a canvas or huddle transcript.
- Add `huddle` to print a huddle's attendees, duration, AI notes and transcript.
- Read huddle transcripts in full: `huddle` and `file --text` print `[mm:ss] Name: text` lines from `files.info` with `include_transcription`, and `--json` adds a `lines` array. `huddle` follows the AI notes canvas to its transcript, and canvas text resolves `@U…` mentions to names.
- Add `since` to return your own posts, replies in your threads, mentions and DMs since a time, in full.
- Add `--unanswered` to `mentions` and `inbox`: keep only items you have not posted after in their thread. A reply posted in the channel instead of the thread is not seen.

## 0.1.0 (2026-08-17)

- Add channel reads, search, threads, mentions, and the activity inbox.
- Add confirmed sends and thread replies.
- Add stored session and environment credentials.
- Add Enterprise Grid token fallback, request limits, and local name caches.
