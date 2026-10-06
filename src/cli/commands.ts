import { Console, Effect, FileSystem, Option, Path } from "effect";
import { Argument, Command, Flag, Prompt } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";

import { WriteNotConfirmed } from "../domain/errors.ts";
import { parseFileTarget } from "../domain/file-text.ts";
import { parseSince } from "../domain/since.ts";
import { parseMessageTarget, parseThreadTarget } from "../domain/thread-target.ts";
import { ChannelDirectory } from "../services/channel-directory.ts";
import { writeSession } from "../services/credentials.ts";
import { Slack } from "../services/slack.ts";
import { collect, verify } from "./login.ts";
import {
  paintFor,
  renderHuddle,
  renderMentions,
  renderMessages,
  renderSearch,
  renderSince,
} from "./render.ts";
import type { RenderOptions } from "./render.ts";

const limit = Flag.integer("limit").pipe(
  Flag.withAlias("n"),
  Flag.filterMap(
    (value) => (value > 0 ? Option.some(value) : Option.none()),
    () => "Expected a positive item limit"
  ),
  Flag.withDefault(20),
  Flag.withDescription("Maximum items to show")
);

const json = Flag.boolean("json").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print the result as JSON instead of formatted text")
);

const full = Flag.boolean("full").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print long messages in full instead of clamping them")
);

const unanswered = Flag.boolean("unanswered").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "Keep only items you have not posted after in their thread (one thread read per item)"
  )
);

const yes = Flag.boolean("yes").pipe(
  Flag.withDefault(false),
  Flag.withAlias("y"),
  Flag.withDescription("Send without asking for confirmation")
);

const channelArgument = Argument.string("channel").pipe(
  Argument.withDescription("Channel name or id, with or without the leading #")
);

/**
 * Message text is variadic so `slackcli send #team ship it` works. Requiring
 * shell quoting for every message is the kind of friction that stops people
 * using a CLI for chat.
 */
const textArgument = Argument.string("text").pipe(
  Argument.variadic({ min: 1 }),
  Argument.withDescription("The message to send")
);

const useColor = (): boolean =>
  process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;

const show = (value: unknown, asJson: boolean, text: () => string) =>
  Console.log(asJson ? JSON.stringify(value, null, 2) : text());

const layout = (config: { readonly full: boolean }): RenderOptions => ({
  paint: paintFor(useColor()),
  now: new Date(),
  full: config.full,
});

/**
 * Posting reaches other people, so silence is never taken as agreement. A
 * terminal user gets one prompt; a script or an agent has to say `--yes`, which
 * keeps an unattended run from writing to a channel by accident.
 */
const confirmWrite = Effect.fn("confirmWrite")(function* (options: {
  readonly action: string;
  readonly target: string;
  readonly text: string;
  readonly approved: boolean;
}) {
  if (options.approved) return;

  if (process.stdin.isTTY !== true) {
    return yield* new WriteNotConfirmed({ action: options.action });
  }

  const paint = paintFor(useColor());
  yield* Console.log(
    `${paint.dim("to")} ${paint.accent(options.target)}\n${options.text}`
  );

  const agreed = yield* Prompt.confirm({ message: "Send this message?" });
  if (!agreed) return yield* new WriteNotConfirmed({ action: options.action });
});

const read = Command.make(
  "read",
  { channel: channelArgument, limit, json, full },
  Effect.fn("read")(function* (config) {
    const slack = yield* Slack;
    const view = yield* slack.read(config.channel, config.limit);
    yield* show(view, config.json, () =>
      renderMessages(view.channel, view.rows, layout(config))
    );
  })
).pipe(Command.withDescription("Show the latest messages in a channel"));

const search = Command.make(
  "search",
  { query: Argument.string("query").pipe(Argument.variadic({ min: 1 })), limit, json, full },
  Effect.fn("search")(function* (config) {
    const slack = yield* Slack;
    const view = yield* slack.search(config.query.join(" "), config.limit);
    yield* show(view, config.json, () =>
      renderSearch(view.rows, { ...layout(config), total: view.total })
    );
  })
).pipe(Command.withDescription("Search messages across the workspace"));

const thread = Command.make(
  "thread",
  {
    target: Argument.string("target").pipe(
      Argument.withDescription("A Slack thread link, or channel:timestamp")
    ),
    limit,
    json,
    full,
  },
  Effect.fn("thread")(function* (config) {
    const slack = yield* Slack;
    const target = yield* Effect.fromResult(parseThreadTarget(config.target));
    const view = yield* slack.thread(target, config.limit);
    const shown = Math.max(0, view.rows.length - 1);
    const complete = shown === view.total && !view.hasMore;
    const total = view.hasMore ? `at least ${view.total}` : String(view.total);
    const header = complete ? view.channel : `${view.channel}  last ${shown} of ${total} replies`;

    yield* show(view, config.json, () => renderMessages(header, view.rows, layout(config)));
  })
).pipe(Command.withDescription("Show recent replies in a thread"));

const huddle = Command.make(
  "huddle",
  {
    target: Argument.string("target").pipe(
      Argument.withDescription("The huddle's thread link, or channel:timestamp")
    ),
    json,
  },
  Effect.fn("huddle")(function* (config) {
    const slack = yield* Slack;
    const target = yield* Effect.fromResult(parseThreadTarget(config.target));
    const view = yield* slack.huddle(target);
    yield* show(view, config.json, () => renderHuddle(view, layout({ full: true })));
  })
).pipe(
  Command.withDescription("Show a huddle: who attended, how long, its AI notes and its transcript")
);

const since = Command.make(
  "since",
  {
    when: Argument.string("when").pipe(
      Argument.withDescription("A duration back from now (3h, 90m, 1d) or an ISO time")
    ),
    limit: Flag.integer("limit").pipe(
      Flag.withAlias("n"),
      Flag.filterMap(
        (value) => (value > 0 ? Option.some(value) : Option.none()),
        () => "Expected a positive item limit"
      ),
      Flag.withDefault(500),
      Flag.withDescription("Maximum messages to return; the newest are kept")
    ),
    json,
  },
  Effect.fn("since")(function* (config) {
    const start = yield* Effect.fromResult(parseSince(config.when, new Date()));
    const slack = yield* Slack;
    const view = yield* slack.since(start, config.limit);
    yield* show(view, config.json, () => renderSince(view, layout({ full: true })));
  })
).pipe(
  Command.withDescription(
    "Everything around you since a time, in full: your posts, replies in your threads, mentions, DMs"
  )
);

/** Both activity commands read the same feed; they differ only in what it filters to. */
const activityCommand = (name: string, scope: "mentions" | "all", description: string) =>
  Command.make(
    name,
    { limit, json, full, unanswered },
    Effect.fn(name)(function* (config) {
      const slack = yield* Slack;
      const view = yield* slack.activity(config.limit, scope, {
        unansweredOnly: config.unanswered,
      });
      yield* show(view, config.json, () => renderMentions(view.rows, layout(config)));
    })
  ).pipe(Command.withDescription(description));

const mentions = activityCommand("mentions", "mentions", "Show the messages that mention you");

const inbox = activityCommand(
  "inbox",
  "all",
  "Show your whole activity feed: mentions, replies, DMs"
);

const send = Command.make(
  "send",
  { channel: channelArgument, text: textArgument, yes, json },
  Effect.fn("send")(function* (config) {
    const slack = yield* Slack;
    const text = config.text.join(" ");

    yield* confirmWrite({
      action: "send",
      target: config.channel,
      text,
      approved: config.yes,
    });

    const posted = yield* slack.send(config.channel, text);
    yield* show(posted, config.json, () => `Sent to ${posted.channel}\n${posted.url}`);
  })
).pipe(Command.withDescription("Post a message to a channel"));

const reply = Command.make(
  "reply",
  {
    target: Argument.string("target").pipe(
      Argument.withDescription("A Slack thread link, or channel:timestamp")
    ),
    text: textArgument,
    yes,
    json,
  },
  Effect.fn("reply")(function* (config) {
    const slack = yield* Slack;
    const target = yield* Effect.fromResult(parseThreadTarget(config.target));
    const text = config.text.join(" ");

    yield* confirmWrite({
      action: "reply",
      target: `${target.channel} thread`,
      text,
      approved: config.yes,
    });

    const posted = yield* slack.reply(target, text);
    yield* show(posted, config.json, () => `Replied in ${posted.channel}\n${posted.url}`);
  })
).pipe(Command.withDescription("Reply inside a thread"));

const edit = Command.make(
  "edit",
  {
    target: Argument.string("target").pipe(
      Argument.withDescription("A link to your own message, or channel:timestamp")
    ),
    text: textArgument,
    yes,
    json,
  },
  Effect.fn("edit")(function* (config) {
    const slack = yield* Slack;
    const target = yield* Effect.fromResult(parseMessageTarget(config.target));
    const text = config.text.join(" ");

    yield* confirmWrite({
      action: "edit",
      target: `${target.channel} message ${target.ts}`,
      text,
      approved: config.yes,
    });

    const edited = yield* slack.edit(target, text);
    yield* show(edited, config.json, () => `Edited in ${edited.channel}\n${edited.url}`);
  })
).pipe(Command.withDescription("Replace the text of one of your own messages"));

/**
 * A file name from Slack is user input. Only its last path segment is used, and
 * anything a shell or a file system would trip over is replaced.
 */
const safeFileName = (name: string): string =>
  name.split(/[\\/]/).pop()?.replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "") || "slack-file";

const file = Command.make(
  "file",
  {
    target: Argument.string("target").pipe(
      Argument.withDescription("A file id (F0123ABCD) or any Slack link to the file")
    ),
    output: Flag.string("output").pipe(
      Flag.withAlias("o"),
      Flag.optional,
      Flag.withDescription("Where to save the file; defaults to its name in the current folder")
    ),
    text: Flag.boolean("text").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Print a canvas, transcript or text file as plain text instead of saving it")
    ),
    json,
  },
  Effect.fn("file")(function* (config) {
    const id = yield* Effect.fromResult(parseFileTarget(config.target));
    const slack = yield* Slack;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const output = Option.getOrUndefined(config.output);

    if (config.text) {
      const view = yield* slack.fileText(id);
      if (output === undefined) {
        yield* show(view, config.json, () => view.text);
        return;
      }
      const target = path.resolve(output);
      yield* fs.writeFileString(target, `${view.text}\n`);
      yield* show({ file: view.file, path: target }, config.json, () => target);
      return;
    }

    const fetched = yield* slack.file(id);
    const target = path.resolve(
      output ?? safeFileName(fetched.file.name ?? fetched.file.title ?? fetched.file.id)
    );
    yield* fs.writeFile(target, fetched.bytes);
    yield* show(
      { file: fetched.file, path: target, bytes: fetched.bytes.length },
      config.json,
      () => target
    );
  })
).pipe(Command.withDescription("Download one Slack file, or print a canvas or transcript as text"));

const refresh = Command.make(
  "refresh",
  {},
  Effect.fn("refresh")(function* () {
    const channels = yield* ChannelDirectory;
    const names = yield* channels.refresh;
    yield* Console.log(`Cached ${names.size} channels`);
  })
).pipe(Command.withDescription("Rebuild the cached channel list"));

/**
 * The token and cookie are flags as well as prompts, so a password manager or a
 * setup script can pipe them in. The prompt is the path a person should take.
 */
const login = Command.make(
  "login",
  {
    host: Flag.string("host").pipe(
      Flag.optional,
      Flag.withDescription("Slack host, as in acme.slack.com")
    ),
    token: Flag.string("token").pipe(
      Flag.optional,
      Flag.withDescription("xoxc- session token from the browser, or an xoxp- token")
    ),
    cookie: Flag.string("cookie").pipe(
      Flag.optional,
      Flag.withDescription("The d cookie value that authorises an xoxc- token")
    ),
    orgToken: Flag.string("org-token").pipe(
      Flag.optional,
      Flag.withDescription("Enterprise Grid org token, for org-wide reads")
    ),
  },
  Effect.fn("login")(function* (config) {
    const entered = yield* collect({
      host: Option.getOrUndefined(config.host),
      token: Option.getOrUndefined(config.token),
      cookie: Option.getOrUndefined(config.cookie),
      orgToken: Option.getOrUndefined(config.orgToken),
    });

    // The credential being checked is not the process credential, so this call
    // gets its own client rather than the one inside the Slack service.
    const verified = yield* verify(entered).pipe(Effect.provide(FetchHttpClient.layer));
    const path = yield* writeSession(verified.session);

    yield* Console.log(
      `Signed in as ${verified.user} on ${verified.workspace}\nCredential stored in ${path}`
    );
  })
).pipe(Command.withDescription("Store a Slack credential after checking it works"));

/**
 * A literal `@name` in an API-posted message renders as plain text; only the
 * raw `<@ID>` syntax pings. This command is how a sender finds that id.
 */
const users = Command.make(
  "users",
  {
    query: Argument.string("query").pipe(
      Argument.variadic({ min: 0 }),
      Argument.withDescription("Name fragment to match; empty lists everyone")
    ),
    limit,
    json,
  },
  Effect.fn("users")(function* (config) {
    const slack = yield* Slack;
    const view = yield* slack.users(config.query.join(" "), config.limit);
    yield* show(view, config.json, () =>
      view.rows.length === 0
        ? "No matching users"
        : view.rows
            .map((row) =>
              [
                row.mention,
                `@${row.handle}`,
                ...(row.realName === undefined ? [] : [row.realName]),
                ...(row.bot ? ["[bot]"] : []),
              ].join("  ")
            )
            .join("\n")
    );
  })
).pipe(Command.withDescription("Find workspace users and the <@id> syntax that mentions them"));

const whoami = Command.make(
  "whoami",
  { json },
  Effect.fn("whoami")(function* (config) {
    const slack = yield* Slack;
    const identity = yield* slack.whoami;
    yield* show(identity, config.json, () =>
      [
        `${identity.user} (${identity.userId})`,
        `${identity.workspace ?? identity.teamId}  ${identity.host}`,
        `credential: ${identity.credential}`,
      ].join("\n")
    );
  })
).pipe(Command.withDescription("Show which Slack account and credential is in use"));

export const slackcli = Command.make("slackcli", {}).pipe(
  Command.withDescription("Read and write Slack from your terminal"),
  Command.withSubcommands([
    read,
    search,
    thread,
    huddle,
    since,
    mentions,
    inbox,
    send,
    reply,
    edit,
    users,
    file,
    login,
    whoami,
    refresh,
  ])
);
