import { randomUUID } from "node:crypto";

import { Context, Effect, Layer } from "effect";

import { SlackAuthExpired, SlackResponseInvalid } from "../domain/errors.ts";
import type { ChannelNotFound, SlackCallError } from "../domain/errors.ts";
import { fileRows } from "../domain/files.ts";
import type { FileRow } from "../domain/files.ts";
import { plainText } from "../domain/file-text.ts";
import { mentionedIds, messageText } from "../domain/message-text.ts";
import {
  ActivityFeedPayload,
  AuthTestPayload,
  ConversationViewPayload,
  FileInfoPayload,
  HistoryPayload,
  PostMessagePayload,
  SearchPayload,
  UsersListPayload,
} from "../domain/slack-schema.ts";
import type { SlackMessage, SlackUser } from "../domain/slack-schema.ts";
import {
  activityPeopleIds,
  activityTargets,
  channelLabel,
  historyRows,
  isChannelLevel,
  mentionRows,
  searchRows,
} from "../domain/rows.ts";
import type { ActivityTarget, MentionRow, MessageRow, SearchRow } from "../domain/rows.ts";
import { permalink } from "../domain/thread-target.ts";
import type { MessageTarget, ThreadTarget } from "../domain/thread-target.ts";
import { ChannelDirectory } from "./channel-directory.ts";
import { SlackApi, slackCall } from "./slack-api.ts";
import { UserDirectory } from "./user-directory.ts";

export interface ChannelView {
  readonly channel: string;
  readonly rows: ReadonlyArray<MessageRow>;
}

export interface SearchView {
  readonly total: number | undefined;
  readonly rows: ReadonlyArray<SearchRow>;
}

export interface ThreadView {
  readonly channel: string;
  /** Replies in the fetched page, so a clipped view can say what it left out. */
  readonly total: number;
  readonly hasMore: boolean;
  readonly rows: ReadonlyArray<MessageRow>;
}

export interface ActivityView {
  readonly rows: ReadonlyArray<MentionRow>;
}

export interface PostedView {
  readonly channel: string;
  readonly ts: string;
  readonly url: string;
}

export interface UserRow {
  readonly id: string;
  /** The raw syntax that pings this user when pasted into a message. */
  readonly mention: string;
  readonly handle: string;
  readonly realName: string | undefined;
  readonly bot: boolean;
}

export interface UsersView {
  readonly rows: ReadonlyArray<UserRow>;
}

export interface IdentityView {
  readonly user: string;
  readonly userId: string;
  readonly teamId: string;
  readonly workspace: string | undefined;
  readonly host: string;
  readonly credential: "session" | "bearer";
}

export interface FetchedFile {
  readonly file: FileRow;
  readonly bytes: Uint8Array;
  readonly contentType: string | undefined;
}

export interface FileTextView {
  readonly file: FileRow;
  readonly text: string;
}

export type ReadError = SlackCallError | ChannelNotFound;

/** Notification kinds where someone addressed the user directly. */
const MENTION_TYPES = ["at_user", "at_user_group", "at_channel", "at_everyone", "keyword"];

/** Everything the Activity tab shows, mentions included. */
const ALL_ACTIVITY_TYPES = [
  ...MENTION_TYPES,
  "thread_v2",
  "message_reaction",
  "bot_dm_bundle",
  "dm",
];

/**
 * The parameters Slack's own client sends to `activity.feed`. The method rejects
 * a request that omits `types` or `mode`, and none of it is documented, so these
 * were read off the browser's own request.
 */
const feedParams = (limit: number, types: ReadonlyArray<string>) => ({
  limit,
  types: types.join(","),
  mode: "chrono_v1",
  archive_only: false,
  unread_only: false,
  priority_only: false,
  is_activity_inbox: true,
});

const HYDRATE_CONCURRENCY = 8;

/** How many replies after a mention are read to find one of the user's own. */
const REPLIES_AFTER_MENTION = 200;

export interface ActivityOptions {
  /** Keep only items the signed-in user has not posted after, in their thread. */
  readonly unansweredOnly?: boolean;
}

/**
 * `users.list` has no server-side name filter, so pages are scanned locally.
 * The cap keeps an enterprise workspace from turning one lookup into an
 * unbounded crawl; five thousand members covers the workspaces this CLI meets.
 */
const USERS_PAGE = 1000;
const USERS_MAX_PAGES = 5;

/** One page that covers a typical thread, so the cut happens locally. */
const THREAD_PAGE = 200;

export class Slack extends Context.Service<
  Slack,
  {
    readonly read: (
      reference: string,
      limit: number
    ) => Effect.Effect<ChannelView, ReadError>;
    readonly search: (
      query: string,
      limit: number
    ) => Effect.Effect<SearchView, SlackCallError>;
    readonly thread: (
      target: ThreadTarget,
      limit: number
    ) => Effect.Effect<ThreadView, SlackCallError>;
    readonly activity: (
      limit: number,
      scope: "mentions" | "all",
      options?: ActivityOptions
    ) => Effect.Effect<ActivityView, SlackCallError>;
    readonly send: (
      reference: string,
      text: string
    ) => Effect.Effect<PostedView, ReadError>;
    readonly reply: (
      target: ThreadTarget,
      text: string
    ) => Effect.Effect<PostedView, SlackCallError>;
    readonly edit: (
      target: MessageTarget,
      text: string
    ) => Effect.Effect<PostedView, SlackCallError>;
    readonly users: (
      query: string,
      limit: number
    ) => Effect.Effect<UsersView, SlackCallError>;
    readonly whoami: Effect.Effect<IdentityView, SlackCallError>;
    /** One file's metadata and bytes, fetched with the session's credentials. */
    readonly file: (id: string) => Effect.Effect<FetchedFile, SlackCallError>;
    /** A canvas, transcript or text file as plain text. */
    readonly fileText: (id: string) => Effect.Effect<FileTextView, SlackCallError>;
  }
>()("slackcli/Slack") {
  static readonly layer: Layer.Layer<
    Slack,
    never,
    SlackApi | ChannelDirectory | UserDirectory
  > = Layer.effect(Slack)(
    Effect.gen(function* () {
      const api = yield* SlackApi;
      const channels = yield* ChannelDirectory;
      const users = yield* UserDirectory;

      /**
       * Every id a batch of messages needs a name for: the authors, and the
       * people those messages mention.
       */
      const peopleIds = (messages: ReadonlyArray<SlackMessage>): ReadonlyArray<string> =>
        messages.flatMap((message) => [
          ...(message.user ? [message.user] : []),
          ...mentionedIds(message),
        ]);

      const read = Effect.fn("Slack.read")(function* (reference: string, limit: number) {
        const channelId = yield* channels.resolve(reference);

        // `conversations.view` returns the channel, its history, its members and
        // its bots together. It is what the Slack client itself calls, and it
        // replaces a history call plus one users.info per author.
        const view = yield* api.call(
          slackCall(
            "conversations.view",
            { channel: channelId, limit, include_stories: false },
            ConversationViewPayload
          )
        );

        // `conversations.view` returns a full screen of channel messages and
        // thread replies whatever `limit` says, so both the filter and the
        // requested count are applied here, newest kept.
        const returned = view.history?.messages ?? view.messages ?? [];
        const messages = returned
          .filter(isChannelLevel)
          .sort((left, right) => Number(right.ts) - Number(left.ts))
          .slice(0, limit);
        const payloadUsers = [...(view.users ?? []), ...(view.bots ?? [])];
        yield* users.seed(payloadUsers);

        const people = yield* users.names(peopleIds(messages));
        const workspace = yield* api.workspaceRef;
        const channelNames = yield* channels.names;

        return {
          channel: channelLabel(channelId, channelNames),
          rows: historyRows(messages, { people, channelId, workspace }),
        } satisfies ChannelView;
      });

      const search = Effect.fn("Slack.search")(function* (query: string, limit: number) {
        const found = yield* api.call(
          slackCall(
            "search.messages",
            { query, count: limit, sort: "timestamp", sort_dir: "desc" },
            SearchPayload
          )
        );

        const payloadUsers = [
          ...Object.values(found.users ?? {}),
          ...Object.values(found.bots ?? {}),
        ];
        yield* users.seed(payloadUsers);

        const matches = found.messages?.matches ?? [];
        const people = yield* users.names(
          matches.flatMap((match) => [
            ...(match.user === undefined ? [] : [match.user]),
            ...mentionedIds(match),
          ])
        );

        return {
          total: found.messages?.total,
          rows: searchRows(matches, { people }),
        } satisfies SearchView;
      });

      /**
       * `conversations.replies` pages from the start of a thread, so asking it
       * for 5 gives the first 5. The end of a conversation is what a reader
       * wants, so the thread is fetched whole and cut here, keeping the message
       * that started it.
       */
      const thread = Effect.fn("Slack.thread")(function* (
        target: ThreadTarget,
        limit: number
      ) {
        const replies = yield* api.call(
          slackCall(
            "conversations.replies",
            { channel: target.channel, ts: target.threadTs, limit: THREAD_PAGE },
            HistoryPayload
          )
        );

        const [root, ...rest] = replies.messages;
        const kept =
          root === undefined ? [] : [root, ...rest.slice(Math.max(0, rest.length - limit))];

        const people = yield* users.names(peopleIds(kept));
        const workspace = yield* api.workspaceRef;

        return {
          channel: channelLabel(target.channel, yield* channels.names),
          total: rest.length,
          hasMore: replies.has_more ?? false,
          // The reply count belongs on a channel row, where it says "there is more
          // to open". Inside the thread the reader is already looking at it.
          rows: historyRows(kept, { people, channelId: target.channel, workspace }).map((row) => ({
            ...row,
            replies: undefined,
          })),
        } satisfies ThreadView;
      });

      /**
       * An activity item names a message but rarely carries its text, and a
       * thread bundle does not even name its author. A reply is not in the
       * channel's history, only in its thread, so the two kinds are fetched
       * through different methods; reading them all through history is what left
       * most rows blank.
       */
      const oneMessage = (
        target: ActivityTarget,
        threadTs: string | undefined
      ): Effect.Effect<SlackMessage | undefined, never> => {
        const method = threadTs === undefined ? "conversations.history" : "conversations.replies";
        const params = {
          channel: target.channel,
          latest: target.ts,
          inclusive: true,
          limit: 1,
          ...(threadTs === undefined ? { oldest: target.ts } : { ts: threadTs }),
        };
        const call = slackCall(method, params, HistoryPayload);

        return api.call(call).pipe(
          Effect.map((payload) => payload.messages.find((message) => message.ts === target.ts)),
          // A channel the token cannot read must not lose the rest of the feed.
          Effect.catch(() => Effect.succeed(undefined))
        );
      };

      /**
       * Fills in whatever the feed left out, so everything downstream reads one
       * complete target instead of joining side tables on channel and timestamp.
       */
      const hydrate = (target: ActivityTarget) =>
        Effect.gen(function* () {
          // An empty text is what the feed sends for a file-only message, so it
          // is fetched like a missing one: the files live only on the message.
          if (target.text !== undefined && target.text !== "") return target;

          const inThread = target.threadTs !== undefined && target.threadTs !== target.ts;
          const found =
            (yield* oneMessage(target, inThread ? target.threadTs : undefined)) ??
            // History holds no thread replies, and a reaction item never says the
            // message it points at is one. Asking for the thread at the reply's
            // own timestamp is what Slack answers with that single reply.
            (inThread ? undefined : yield* oneMessage(target, target.ts));

          if (found === undefined) return target;
          return {
            ...target,
            text: messageText(found),
            files: found.files,
            authorId: target.authorId ?? found.user,
          } satisfies ActivityTarget;
        });

      /**
       * A mention counts as answered when the user posted in its thread after it.
       * A top-level mention is its own thread root, so a reply under it counts
       * too. A thread the token cannot read keeps the mention, so nothing that
       * still needs an answer is hidden.
       */
      const repliedAfter = (target: ActivityTarget, userId: string) =>
        api
          .call(
            slackCall(
              "conversations.replies",
              {
                channel: target.channel,
                ts: target.threadTs ?? target.ts,
                oldest: target.ts,
                limit: REPLIES_AFTER_MENTION,
              },
              HistoryPayload
            )
          )
          .pipe(
            Effect.map((payload) =>
              payload.messages.some(
                (message) => message.user === userId && Number(message.ts) > Number(target.ts)
              )
            ),
            Effect.catch(() => Effect.succeed(false))
          );

      const activity = Effect.fn("Slack.activity")(function* (
        limit: number,
        scope: "mentions" | "all",
        options: ActivityOptions = {}
      ) {
        const feed = yield* api.call(
          slackCall(
            "activity.feed",
            feedParams(limit, scope === "all" ? ALL_ACTIVITY_TYPES : MENTION_TYPES),
            ActivityFeedPayload
          )
        );

        const hydrated = yield* Effect.forEach(activityTargets(feed.items), hydrate, {
          concurrency: HYDRATE_CONCURRENCY,
        });
        const targets = options.unansweredOnly
          ? yield* Effect.gen(function* () {
              const identity = yield* api.call(slackCall("auth.test", {}, AuthTestPayload));
              const answered = yield* Effect.forEach(
                hydrated,
                (target) => repliedAfter(target, identity.user_id),
                { concurrency: HYDRATE_CONCURRENCY }
              );
              return hydrated.filter((_, index) => !answered[index]);
            })
          : hydrated;

        const people = yield* users.names(targets.flatMap(activityPeopleIds));
        const channelNames = yield* channels.names;
        const workspace = yield* api.workspaceRef;

        return {
          rows: mentionRows(targets, {
            people,
            channels: channelNames,
            workspace,
          }),
        } satisfies ActivityView;
      });

      const post = Effect.fn("Slack.post")(function* (
        channel: string,
        text: string,
        threadTs?: string
      ) {
        const posted = yield* api.call(
          slackCall(
            "chat.postMessage",
            {
              channel,
              text,
              client_msg_id: randomUUID(),
              ...(threadTs ? { thread_ts: threadTs } : {}),
            },
            PostMessagePayload
          )
        );

        const workspace = yield* api.workspaceRef;
        const channelNames = yield* channels.names;
        return {
          channel: channelLabel(posted.channel, channelNames),
          ts: posted.ts,
          url: permalink(workspace, posted.channel, posted.ts),
        } satisfies PostedView;
      });

      const edit = Effect.fn("Slack.edit")(function* (target: MessageTarget, text: string) {
        const edited = yield* api.call(
          slackCall(
            "chat.update",
            { channel: target.channel, ts: target.ts, text },
            PostMessagePayload
          )
        );

        const workspace = yield* api.workspaceRef;
        const channelNames = yield* channels.names;
        return {
          channel: channelLabel(edited.channel, channelNames),
          ts: edited.ts,
          url: permalink(workspace, edited.channel, edited.ts),
        } satisfies PostedView;
      });

      const listUsers = Effect.fn("Slack.users")(function* (query: string, limit: number) {
        const wanted = query.toLowerCase();
        const matches = (user: SlackUser): boolean => {
          if (user.deleted === true) return false;
          if (wanted.length === 0) return true;
          return [
            user.name,
            user.real_name,
            user.profile?.display_name,
            user.profile?.real_name,
          ].some((field) => field !== undefined && field.toLowerCase().includes(wanted));
        };

        const page = (
          cursor: string | undefined,
          found: ReadonlyArray<SlackUser>,
          remaining: number
        ): Effect.Effect<ReadonlyArray<SlackUser>, SlackCallError> =>
          api
            .call(slackCall("users.list", { limit: USERS_PAGE, cursor }, UsersListPayload))
            .pipe(
              Effect.flatMap((payload) => {
                const collected = [...found, ...payload.members.filter(matches)];
                const next = payload.response_metadata?.next_cursor;
                const more =
                  next !== undefined &&
                  next.length > 0 &&
                  remaining > 1 &&
                  collected.length < limit;
                return more ? page(next, collected, remaining - 1) : Effect.succeed(collected);
              })
            );

        const found = yield* page(undefined, [], USERS_MAX_PAGES);
        return {
          rows: found.slice(0, limit).map((user) => ({
            id: user.id,
            mention: `<@${user.id}>`,
            handle: user.name ?? user.id,
            realName: user.profile?.real_name ?? user.real_name,
            bot: user.is_bot ?? false,
          })),
        } satisfies UsersView;
      });

      const whoami = Effect.fn("Slack.whoami")(function* () {
        const session = yield* api.session;
        const identity = yield* api.call(slackCall("auth.test", {}, AuthTestPayload));

        return {
          user: identity.user ?? identity.user_id,
          userId: identity.user_id,
          teamId: identity.team_id,
          workspace: identity.team,
          host: session.host,
          credential: session.auth.kind,
        } satisfies IdentityView;
      })();

      const fetchFile = Effect.fn("Slack.file")(function* (id: string) {
        const info = yield* api.call(slackCall("files.info", { file: id }, FileInfoPayload));
        const [row] = fileRows([info.file]);
        const url = info.file.url_private_download ?? info.file.url_private;
        if (row === undefined || url === undefined) {
          return yield* new SlackResponseInvalid({
            method: "files.info",
            detail: `file ${id} has no download URL (mode: ${info.file.mode ?? "unknown"})`,
          });
        }

        const downloaded = yield* api.download(url);
        // Slack answers an unauthorised file request with its sign-in page, as
        // a 200. Only a canvas is expected to be HTML.
        const html = downloaded.contentType?.toLowerCase().includes("text/html") === true;
        if (html && row.kind === "file" && row.mimetype?.includes("html") !== true) {
          return yield* new SlackAuthExpired({
            slackError: "the file download returned a sign-in page",
          });
        }

        return {
          file: row,
          bytes: downloaded.bytes,
          contentType: downloaded.contentType,
        } satisfies FetchedFile;
      });

      const fileText = Effect.fn("Slack.fileText")(function* (id: string) {
        const fetched = yield* fetchFile(id);
        const raw = new TextDecoder().decode(fetched.bytes);
        return { file: fetched.file, text: plainText(raw, fetched.contentType) } satisfies FileTextView;
      });

      return {
        file: fetchFile,
        fileText,
        read,
        search,
        thread,
        activity,
        users: listUsers,
        whoami,
        send: (reference: string, text: string) =>
          channels.resolve(reference).pipe(Effect.flatMap((channel) => post(channel, text))),
        reply: (target: ThreadTarget, text: string) =>
          post(target.channel, text, target.threadTs),
        edit,
      };
    })
  );
}
