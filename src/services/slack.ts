import { randomUUID } from "node:crypto";

import { Context, Effect, Layer } from "effect";

import { explain, SlackAuthExpired, SlackResponseInvalid } from "../domain/errors.ts";
import type { ChannelNotFound, SlackCallError } from "../domain/errors.ts";
import { fileKind, fileRows } from "../domain/files.ts";
import type { FileRow } from "../domain/files.ts";
import { plainText } from "../domain/file-text.ts";
import {
  mentionedIds,
  messageText,
  readableMessage,
  slackTsToIso,
} from "../domain/message-text.ts";
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
import type {
  ActivityItem,
  SearchMatch,
  SlackFile,
  SlackMessage,
  SlackUser,
} from "../domain/slack-schema.ts";
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
import { searchDay } from "../domain/since.ts";
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

export interface HuddleView {
  readonly channel: string;
  readonly url: string;
  /** False when the thread is not one a huddle posted, so nothing else applies. */
  readonly isHuddle: boolean;
  readonly attendees: ReadonlyArray<string>;
  readonly startedAt: string | undefined;
  readonly durationSeconds: number | undefined;
  readonly ended: boolean;
  readonly notes: FileTextView | undefined;
  readonly transcript: FileTextView | undefined;
  /** "AI notes" and "transcript" when absent, with the reason when a download failed. */
  readonly missing: ReadonlyArray<string>;
}

/** One message in a `since` window, wherever it was found. */
export interface SinceRow {
  readonly channel: string;
  readonly channelId: string;
  /** The thread the message belongs to; the message's own link when it has none. */
  readonly thread: string;
  readonly url: string;
  readonly author: string;
  readonly authorId: string | undefined;
  /** True for the signed-in user's own posts. */
  readonly mine: boolean;
  readonly at: string;
  readonly message: string;
  readonly files: ReadonlyArray<FileRow>;
}

export interface SinceView {
  readonly since: string;
  readonly until: string;
  /** Rows dropped because the window held more than the limit; the oldest go first. */
  readonly cut: number;
  readonly rows: ReadonlyArray<SinceRow>;
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

/** Slack refuses `activity.feed` with `invalid_arguments` above this many items. */
const FEED_PAGE = 50;

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

/**
 * Matches asked for per search page. Every page asks for the same count,
 * because Slack numbers its pages by it; a session token may still get fewer.
 */
const SEARCH_PAGE = 100;
const SEARCH_MAX_PAGES = 50;
/** One page that covers a typical thread, so the cut happens locally. */
const THREAD_PAGE = 200;

/** Threads and DMs read for one `since` window, so a busy day stays bounded. */
const SINCE_MAX_CONVERSATIONS = 80;
/** Feed items read for one `since` window: about two weeks of a busy feed. */
const SINCE_FEED_ITEMS = 1000;
const SINCE_ACTIVITY_TYPES = [...MENTION_TYPES, "thread_v2", "dm"];

const THREAD_TS_IN_LINK = /[?&]thread_ts=(\d{10}\.\d{6})/;

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
    readonly huddle: (target: ThreadTarget) => Effect.Effect<HuddleView, SlackCallError>;
    /** Everything around the signed-in user since a Unix time, oldest first. */
    readonly since: (sinceSeconds: number, limit: number) => Effect.Effect<SinceView, SlackCallError>;
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

      const searchPage = (query: string, page: number) =>
        api.call(
          slackCall(
            "search.messages",
            { query, count: SEARCH_PAGE, page, sort: "timestamp", sort_dir: "desc" },
            SearchPayload
          )
        );

      /**
       * Slack answers search one page per call, and a session token gets at
       * most 20 matches a page whatever `count` asks for. Pages are read
       * until `limit` matches are in hand, Slack has no more, or `stopAt`
       * says the newest-first matches went past what the caller needs.
       */
      const searchMatches = Effect.fnUntraced(function* (
        query: string,
        limit: number,
        stopAt: (oldest: SearchMatch) => boolean = () => false
      ) {
        const matches: Array<SearchMatch> = [];
        let total: number | undefined;
        let pages = 1;
        for (let page = 1; page <= Math.min(pages, SEARCH_MAX_PAGES); page += 1) {
          const found = yield* searchPage(query, page);
          const more = found.messages?.matches ?? [];
          total ??= found.messages?.total;
          pages = found.messages?.paging?.pages ?? pages;
          matches.push(...more);
          yield* users.seed([...Object.values(found.users ?? {}), ...Object.values(found.bots ?? {})]);
          const oldest = matches.at(-1);
          if (more.length === 0 || matches.length >= limit) break;
          if (oldest !== undefined && stopAt(oldest)) break;
        }
        return { total, matches: matches.slice(0, limit) };
      });

      const search = Effect.fn("Slack.search")(function* (query: string, limit: number) {
        const { total, matches } = yield* searchMatches(query, limit);
        const people = yield* users.names(
          matches.flatMap((match) => [
            ...(match.user === undefined ? [] : [match.user]),
            ...mentionedIds(match),
          ])
        );

        return {
          total,
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

      /**
       * Reads the feed page by page through its cursor, newest first, until
       * `maxItems` are in hand, Slack has no more, or a page reaches items
       * older than `oldest`.
       */
      const readFeed = Effect.fnUntraced(function* (
        maxItems: number,
        types: ReadonlyArray<string>,
        oldest?: number
      ) {
        const items: Array<ActivityItem> = [];
        let cursor: string | undefined;
        do {
          const page = yield* api.call(
            slackCall(
              "activity.feed",
              {
                ...feedParams(Math.min(FEED_PAGE, maxItems - items.length), types),
                cursor,
              },
              ActivityFeedPayload
            )
          );
          items.push(...page.items);
          cursor = page.response_metadata?.next_cursor || undefined;
          if (
            oldest !== undefined &&
            activityTargets(page.items).some((target) => Number(target.ts) < oldest)
          ) {
            break;
          }
        } while (cursor !== undefined && items.length < maxItems);
        return items.slice(0, maxItems);
      });

      const activity = Effect.fn("Slack.activity")(function* (
        limit: number,
        scope: "mentions" | "all",
        options: ActivityOptions = {}
      ) {
        const feed = yield* readFeed(limit, scope === "all" ? ALL_ACTIVITY_TYPES : MENTION_TYPES);

        const hydrated = yield* Effect.forEach(activityTargets(feed), hydrate, {
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

      const fileInfo = (id: string) =>
        api
          .call(slackCall("files.info", { file: id }, FileInfoPayload))
          .pipe(Effect.map((payload) => payload.file));

      const downloadFile = Effect.fn("Slack.downloadFile")(function* (file: SlackFile) {
        const [row] = fileRows([file]);
        const url = file.url_private_download ?? file.url_private;
        if (row === undefined || url === undefined) {
          return yield* new SlackResponseInvalid({
            method: "files.info",
            detail: `file ${file.id} has no download URL (mode: ${file.mode ?? "unknown"})`,
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

      const fetchFile = (id: string) => fileInfo(id).pipe(Effect.flatMap(downloadFile));

      const textOf = (file: SlackFile) =>
        downloadFile(file).pipe(
          Effect.map((fetched) => {
            const raw = new TextDecoder().decode(fetched.bytes);
            return { file: fetched.file, text: plainText(raw, fetched.contentType) } satisfies FileTextView;
          })
        );

      const fileText = (id: string) => fileInfo(id).pipe(Effect.flatMap(textOf));

      /**
       * A huddle posts one message in its channel and carries its notes canvas
       * and transcript as files: listed on the room, and posted in the thread.
       * Both lists are read, because either can be the only one that has them.
       */
      const huddle = Effect.fn("Slack.huddle")(function* (target: ThreadTarget) {
        const replies = yield* api.call(
          slackCall(
            "conversations.replies",
            { channel: target.channel, ts: target.threadTs, limit: THREAD_PAGE },
            HistoryPayload
          )
        );
        const workspace = yield* api.workspaceRef;
        const channel = channelLabel(target.channel, yield* channels.names);
        const url = permalink(workspace, target.channel, target.threadTs);
        const room = replies.messages.find((message) => message.room !== undefined)?.room;
        const isHuddle =
          room !== undefined ||
          replies.messages.some((message) => message.subtype === "huddle_thread");

        if (!isHuddle) {
          return {
            channel,
            url,
            isHuddle,
            attendees: [],
            startedAt: undefined,
            durationSeconds: undefined,
            ended: false,
            notes: undefined,
            transcript: undefined,
            missing: [],
          } satisfies HuddleView;
        }

        const ids = [
          ...new Set([
            ...(room?.attached_file_ids ?? []),
            ...replies.messages.flatMap((message) => (message.files ?? []).map((file) => file.id)),
          ]),
        ];
        const files = yield* Effect.forEach(
          ids,
          (id) => fileInfo(id).pipe(Effect.catch(() => Effect.succeed(undefined))),
          { concurrency: HYDRATE_CONCURRENCY }
        ).pipe(Effect.map((found) => found.filter((file) => file !== undefined)));

        const canvases = files.filter((file) => fileKind(file) === "canvas");
        const notesFile =
          canvases.find((file) => /huddle notes/i.test(file.title ?? file.name ?? "")) ?? canvases[0];
        const transcriptFile = files.find((file) => fileKind(file) === "transcript");

        const missing: Array<string> = [];
        const read = (file: SlackFile | undefined, label: string) =>
          file === undefined
            ? Effect.sync(() => {
                missing.push(label);
                return undefined;
              })
            : textOf(file).pipe(
                Effect.catch((error: SlackCallError) =>
                  Effect.sync(() => {
                    missing.push(`${label} (${explain(error) ?? error._tag})`);
                    return undefined;
                  })
                )
              );

        const notes = yield* read(notesFile, "AI notes");
        const transcript = yield* read(transcriptFile, "transcript");
        const attendeeIds = room?.participant_history ?? room?.participants ?? [];
        const people = yield* users.names(attendeeIds);

        return {
          channel,
          url,
          isHuddle,
          attendees: attendeeIds.map((id) => people.get(id) ?? id),
          startedAt: room?.date_start === undefined ? undefined : slackTsToIso(String(room.date_start)),
          durationSeconds:
            room?.date_start !== undefined && room.date_end !== undefined && room.date_end > 0
              ? room.date_end - room.date_start
              : undefined,
          ended: room?.has_ended ?? false,
          notes,
          transcript,
          missing,
        } satisfies HuddleView;
      });

      /**
       * Everything a person needs to have read since a time, in one call: their
       * own posts anywhere (from search), every message in the threads they
       * posted in, were mentioned in or follow (from the activity feed), and
       * their DMs. Each conversation is read once, whole from the window start,
       * so nothing is clipped and replies by others come with it.
       */
      const since = Effect.fn("Slack.since")(function* (sinceSeconds: number, limit: number) {
        const until = Date.now() / 1000;
        const inWindow = (ts: string) => Number(ts) >= sinceSeconds;
        const identity = yield* api.call(slackCall("auth.test", {}, AuthTestPayload));

        const ownPosts = searchMatches(
          `from:me after:${searchDay(sinceSeconds)}`,
          SEARCH_PAGE * SEARCH_MAX_PAGES,
          (oldest) => !inWindow(oldest.ts)
        ).pipe(Effect.map(({ matches }) => matches.filter((match) => inWindow(match.ts))));

        const feed = readFeed(SINCE_FEED_ITEMS, SINCE_ACTIVITY_TYPES, sinceSeconds).pipe(
          Effect.map((items) => activityTargets(items).filter((item) => inWindow(item.ts)))
        );

        const [posts, activity] = yield* Effect.all([ownPosts, feed], { concurrency: 2 });

        // A conversation is a thread (channel + root) or a whole DM (channel only).
        const threads = new Map<string, { readonly channel: string; readonly root: string }>();
        const dms = new Set<string>();
        const addThread = (channel: string | undefined, root: string) => {
          if (channel !== undefined) threads.set(`${channel}:${root}`, { channel, root });
        };
        for (const post of posts) {
          const root = THREAD_TS_IN_LINK.exec(post.permalink ?? "")?.[1] ?? post.ts;
          addThread(post.channel?.id, root);
        }
        for (const item of activity) {
          if (item.kind === "dm" || item.kind === "bot_dm_bundle") dms.add(item.channel);
          else addThread(item.channel, item.threadTs ?? item.ts);
        }

        const readThread = (thread: { readonly channel: string; readonly root: string }) =>
          api
            .call(
              slackCall(
                "conversations.replies",
                { channel: thread.channel, ts: thread.root, oldest: sinceSeconds, limit: THREAD_PAGE },
                HistoryPayload
              )
            )
            .pipe(
              Effect.map((payload) =>
                payload.messages.map((message) => ({ channel: thread.channel, root: thread.root, message }))
              ),
              // One thread the token cannot read must not lose the rest.
              Effect.catch(() => Effect.succeed([]))
            );

        const readDm = (channel: string) =>
          api
            .call(
              slackCall(
                "conversations.history",
                { channel, oldest: sinceSeconds, limit: THREAD_PAGE },
                HistoryPayload
              )
            )
            .pipe(
              Effect.map((payload) =>
                payload.messages.map((message) => ({
                  channel,
                  root: message.thread_ts ?? message.ts,
                  message,
                }))
              ),
              Effect.catch(() => Effect.succeed([]))
            );

        const conversations = [
          ...[...threads.values()].map(readThread),
          ...[...dms].map(readDm),
        ].slice(0, SINCE_MAX_CONVERSATIONS);
        const read = (yield* Effect.all(conversations, { concurrency: HYDRATE_CONCURRENCY })).flat();

        // A post found by search and again in its thread is one message; the
        // thread copy wins because it carries the files.
        const found = new Map<
          string,
          { readonly channel: string; readonly root: string; readonly message: SlackMessage }
        >();
        for (const post of posts) {
          const channel = post.channel?.id;
          if (channel === undefined) continue;
          const root = THREAD_TS_IN_LINK.exec(post.permalink ?? "")?.[1] ?? post.ts;
          const { channel: _where, ...fields } = post;
          found.set(`${channel}:${post.ts}`, {
            channel,
            root,
            message: { ...fields, channel, user: post.user ?? identity.user_id },
          });
        }
        for (const entry of read) {
          if (inWindow(entry.message.ts)) found.set(`${entry.channel}:${entry.message.ts}`, entry);
        }

        const ordered = [...found.values()].sort(
          (left, right) => Number(left.message.ts) - Number(right.message.ts)
        );
        const kept = ordered.slice(Math.max(0, ordered.length - limit));

        const people = yield* users.names(kept.flatMap((entry) => peopleIds([entry.message])));
        const workspace = yield* api.workspaceRef;
        const channelNames = yield* channels.names;

        return {
          since: new Date(sinceSeconds * 1000).toISOString(),
          until: new Date(until * 1000).toISOString(),
          cut: ordered.length - kept.length,
          rows: kept.map(({ channel, root, message }) => ({
            channel: channelLabel(channel, channelNames),
            channelId: channel,
            thread: permalink(workspace, channel, root),
            url: permalink(workspace, channel, message.ts, root),
            author:
              (message.user === undefined ? undefined : people.get(message.user)) ??
              message.username ??
              message.user ??
              "Slack user",
            authorId: message.user,
            mine: message.user === identity.user_id,
            at: slackTsToIso(message.ts),
            message: readableMessage(message, people),
            files: fileRows(message.files),
          })),
        } satisfies SinceView;
      });

      return {
        since,
        file: fetchFile,
        fileText,
        huddle,
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
