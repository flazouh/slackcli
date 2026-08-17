import {
  mentionedIds,
  NO_TEXT,
  readableMessage,
  readableSlackText,
  slackTsToIso,
} from "./message-text.ts";
import type { PeopleIndex } from "./message-text.ts";
import { permalink } from "./thread-target.ts";
import type { ActivityItem, SearchMatch, SlackMessage } from "./slack-schema.ts";

export interface MessageRow {
  readonly author: string;
  readonly message: string;
  readonly at: string;
  readonly url: string;
  /** Present on a message that started a thread, so the reader knows to open it. */
  readonly replies: number | undefined;
}

export interface SearchRow {
  readonly channel: string;
  readonly author: string;
  readonly message: string;
  readonly at: string;
  readonly url: string | undefined;
}

export interface MentionRow {
  readonly notification: string;
  readonly unread: boolean;
  readonly channel: string;
  readonly author: string;
  readonly message: string;
  readonly at: string;
  readonly url: string;
}

/**
 * A reply belongs to its thread, not to the channel. `conversations.view`
 * returns both, so a channel read drops the replies and keeps the parents; the
 * reply count on a parent is what points the reader at the thread.
 */
export const isChannelLevel = (message: SlackMessage): boolean =>
  message.thread_ts === undefined || message.thread_ts === message.ts;

const authorOf = (message: SlackMessage, people: PeopleIndex): string => {
  const known = message.user ? people.get(message.user) : undefined;
  return known ?? message.username ?? (message.bot_id ? "Slack bot" : message.user ?? "Slack user");
};

export const historyRows = (
  messages: ReadonlyArray<SlackMessage>,
  context: { readonly people: PeopleIndex; readonly channelId: string; readonly workspace: string }
): ReadonlyArray<MessageRow> =>
  [...messages]
    .sort((left, right) => Number(left.ts) - Number(right.ts))
    .map((message) => ({
      author: authorOf(message, context.people),
      message: readableMessage(message, context.people),
      at: slackTsToIso(message.ts),
      url: permalink(context.workspace, context.channelId, message.ts),
      replies: message.reply_count,
    }));

export const searchRows = (
  matches: ReadonlyArray<SearchMatch>,
  context: { readonly people: PeopleIndex }
): ReadonlyArray<SearchRow> =>
  matches.map((match) => ({
    channel: `#${match.channel?.name ?? "unknown"}`,
    author:
      match.username ??
      (match.user === undefined ? "unknown" : context.people.get(match.user) ?? match.user),
    message: readableMessage(match, context.people),
    at: slackTsToIso(match.ts),
    url: match.permalink,
  }));

/**
 * Slack's own labels for activity kinds are internal strings. These are the
 * words a person would use for the same thing.
 */
const NOTIFICATION_LABELS: Readonly<Record<string, string>> = {
  at_user: "Direct mention",
  at_channel: "@channel mention",
  at_everyone: "@everyone mention",
  at_user_group: "Group mention",
  keyword: "Keyword match",
  thread_v2: "Thread reply",
  message_reaction: "Reaction",
  dm: "Direct message",
  bot_dm_bundle: "App message",
  unjoined_channel_mention: "Mention in a channel you have not joined",
};

const notificationLabel = (type: string): string => NOTIFICATION_LABELS[type] ?? type;

/**
 * Direct message channels have no name, so an unresolved `D…` id is labelled
 * rather than printed as if it were a channel someone could open by name.
 */
export const channelLabel = (id: string, names: ReadonlyMap<string, string>): string => {
  const name = names.get(id);
  if (name) return `#${name}`;
  return id.startsWith("D") ? "DM" : `#${id}`;
};

/**
 * One activity item, flattened: whichever message the notification is about,
 * plus who caused it. Everything downstream works from this, so it never has to
 * know which of Slack's four item shapes produced a row.
 */
export interface ActivityTarget {
  readonly kind: string;
  readonly channel: string;
  /** The message to show and to link to. */
  readonly ts: string;
  /** Set when the message lives in a thread, which is how it gets fetched. */
  readonly threadTs: string | undefined;
  readonly authorId: string | undefined;
  readonly text: string | undefined;
  readonly reactorId: string | undefined;
  readonly reactionName: string | undefined;
  readonly unreadCount: number | undefined;
  readonly unread: boolean;
  readonly bot: boolean;
}

// The arms are told apart by the fields they carry, not by `type`: Slack sends
// types this version has never seen, so the catch-all arm keeps a `string` type
// that no literal can be narrowed against.
export const activityTargets = (
  items: ReadonlyArray<ActivityItem>
): ReadonlyArray<ActivityTarget> =>
  items.flatMap((entry): ReadonlyArray<ActivityTarget> => {
    const item = entry.item;
    const common: Omit<ActivityTarget, "channel" | "ts" | "threadTs"> = {
      kind: item.type,
      unread: entry.is_unread ?? false,
      bot: entry.is_bot ?? false,
      reactorId: undefined,
      reactionName: undefined,
      unreadCount: undefined,
      authorId: undefined,
      text: undefined,
    };

    if ("reaction" in item) {
      return [
        {
          ...common,
          channel: item.message.channel,
          ts: item.message.ts,
          threadTs: item.message.thread_ts,
          reactorId: item.reaction.user,
          reactionName: item.reaction.name,
        },
      ];
    }

    if ("bundle_info" in item) {
      const payload = item.bundle_info.payload;
      if ("thread_entry" in payload) {
        const thread = payload.thread_entry;
        return [
          {
            ...common,
            channel: thread.channel_id,
            ts: thread.latest_ts,
            threadTs: thread.thread_ts,
            unreadCount: thread.unread_msg_count,
          },
        ];
      }

      const latest = payload.dm_entry.latest_message;
      return [
        {
          ...common,
          channel: latest.channel,
          ts: latest.ts,
          threadTs: latest.thread_ts,
          authorId: latest.author_user_id,
          text: latest.text,
        },
      ];
    }

    if (!("message" in item)) return [];

    return [
      {
        ...common,
        channel: item.message.channel,
        ts: item.message.ts,
        threadTs: item.message.thread_ts,
        authorId: item.message.author_user_id,
        text: item.message.text,
      },
    ];
  });

/** A reaction is described by its emoji, which says more than the word "Reaction". */
const activityLabel = (target: ActivityTarget): string => {
  if (target.kind === "message_reaction") {
    return target.reactionName === undefined
      ? "Reaction"
      : `Reacted :${target.reactionName}:`;
  }

  const label = notificationLabel(target.kind);
  return target.unreadCount !== undefined && target.unreadCount > 1
    ? `${label} (${target.unreadCount} unread)`
    : label;
};

/**
 * On a reaction the person to name is whoever reacted, since the message itself
 * is the reader's own. Everywhere else it is the author.
 */
const personOf = (target: ActivityTarget): string | undefined =>
  target.kind === "message_reaction" ? target.reactorId : target.authorId;

/** Every id a row needs a display name for. */
export const activityPeopleIds = (target: ActivityTarget): ReadonlyArray<string> => {
  const person = personOf(target);
  return [...(person === undefined ? [] : [person]), ...mentionedIds({ text: target.text })];
};

export const mentionRows = (
  targets: ReadonlyArray<ActivityTarget>,
  context: {
    readonly people: PeopleIndex;
    readonly channels: ReadonlyMap<string, string>;
    readonly workspace: string;
  }
): ReadonlyArray<MentionRow> =>
  targets.map((target) => {
    const personId = personOf(target);
    const named = personId === undefined ? undefined : context.people.get(personId);

    return {
      notification: activityLabel(target),
      unread: target.unread,
      channel: channelLabel(target.channel, context.channels),
      author: named ?? (target.bot ? "Slack bot" : personId ?? "Slack user"),
      message: target.text ? readableSlackText(target.text, context.people) : NO_TEXT,
      at: slackTsToIso(target.ts),
      url: permalink(context.workspace, target.channel, target.ts, target.threadTs),
    };
  });
