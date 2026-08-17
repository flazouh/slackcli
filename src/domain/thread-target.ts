import { Result, Schema } from "effect";

import { ThreadTargetInvalid } from "./errors.ts";

export const ChannelId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[CDG][A-Z0-9]+$/)),
  Schema.brand("ChannelId")
).annotate({ identifier: "ChannelId" });
export type ChannelId = typeof ChannelId.Type;

/**
 * A Slack message timestamp: ten digits, a dot, six digits. It doubles as a
 * message's identity, so it is branded rather than left as a bare string.
 */
const MessageTs = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{10}\.\d{6}$/)),
  Schema.brand("MessageTs")
).annotate({ identifier: "MessageTs" });
type MessageTs = typeof MessageTs.Type;

export interface ThreadTarget {
  readonly channel: ChannelId;
  readonly threadTs: MessageTs;
}

// Both the "Copy link" permalink and the in-app URL of a focused message, which
// is also the form this tool prints, so its own output can be pasted back in.
const PERMALINK = /\/(?:archives|client\/[^/]+)\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})/;
const IN_APP_THREAD = /\/client\/[^/]+\/([CDG][A-Z0-9]+)\/thread\/[CDG][A-Z0-9]+-(\d{10}\.\d{6})/;
const EXPLICIT = /^([CDG][A-Z0-9]+):(\d{10}\.\d{6})$/;
const THREAD_TS_QUERY = /[?&]thread_ts=(\d{10}\.\d{6})/;

// `make` runs the schema's checks, so a regex change that stops matching Slack's
// id format fails loudly here instead of producing a bad permalink.
const target = (channel: string, threadTs: string): ThreadTarget => ({
  channel: ChannelId.make(channel),
  threadTs: MessageTs.make(threadTs),
});

/**
 * A pasted Slack link is the only thread address a person actually has, so every
 * shape Slack hands out is accepted: the "Copy link" permalink, the in-app
 * message and thread URLs, and the explicit `channel:ts` pair.
 */
export const parseThreadTarget = (
  value: string
): Result.Result<ThreadTarget, ThreadTargetInvalid> => {
  const inApp = IN_APP_THREAD.exec(value);
  if (inApp?.[1] && inApp[2]) return Result.succeed(target(inApp[1], inApp[2]));

  const explicit = EXPLICIT.exec(value.trim());
  if (explicit?.[1] && explicit[2]) return Result.succeed(target(explicit[1], explicit[2]));

  const archives = PERMALINK.exec(value);
  if (archives?.[1] && archives[2] && archives[3]) {
    // The permalink's own ts points at the reply that was linked. thread_ts,
    // when the link carries it, points at the root, which is what a reply needs.
    const root = THREAD_TS_QUERY.exec(value);
    return Result.succeed(
      target(archives[1], root?.[1] ?? `${archives[2]}.${archives[3]}`)
    );
  }

  return Result.fail(new ThreadTargetInvalid({ value }));
};

/**
 * Slack permalinks encode the timestamp with the dot removed. A link to a reply
 * carries the thread root the way Slack's own "Copy link" does, so pasting the
 * link back into `slackcli thread` opens the thread and not the lone reply.
 */
export const permalink = (
  workspace: string,
  channel: string,
  ts: string,
  threadTs?: string
): string => {
  const url = `https://app.slack.com/client/${workspace}/${channel}/p${ts.replace(".", "")}`;
  return threadTs === undefined || threadTs === ts ? url : `${url}?thread_ts=${threadTs}`;
};
