import { expect, test } from "bun:test";
import { Effect, Layer, Result } from "effect";

import { ChannelId, parseThreadTarget } from "../domain/thread-target.ts";
import { ChannelDirectory } from "./channel-directory.ts";
import { Slack } from "./slack.ts";
import { SlackApi } from "./slack-api.ts";
import { UserDirectory } from "./user-directory.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const threadTarget = (value: string) => {
  const parsed = parseThreadTarget(value);
  if (Result.isFailure(parsed)) throw parsed.failure;
  return parsed.success;
};

const stubApi = (
  answers: Readonly<Record<string, ReadonlyArray<unknown>>>,
  downloads: Readonly<Record<string, { readonly body: string; readonly contentType: string }>> = {}
) => {
  const calls: Array<string> = [];
  const requests: Array<{
    readonly method: string;
    readonly params: Readonly<Record<string, unknown>>;
  }> = [];
  const remaining = new Map(
    Object.entries(answers).map(([method, bodies]) => [method, [...bodies]])
  );
  const layer = Layer.succeed(SlackApi)({
    call: (request) => {
      calls.push(request.method);
      requests.push({ method: request.method, params: request.params });
      const body = remaining.get(request.method)?.shift();
      if (body === undefined) return Effect.die(`Unexpected call to ${request.method}`);
      return request.decode(body).pipe(Effect.orDie);
    },
    workspaceRef: Effect.succeed("T1"),
    session: Effect.die("the Slack service must not read credentials directly"),
    download: (url) => {
      calls.push(`download ${url}`);
      const found = downloads[url];
      return found === undefined
        ? Effect.die(`Unexpected download of ${url}`)
        : Effect.succeed({ bytes: new TextEncoder().encode(found.body), contentType: found.contentType });
    },
  });

  return { calls, requests, layer };
};

const channels = Layer.succeed(ChannelDirectory)({
  resolve: () => Effect.succeed(ChannelId.make("C1")),
  names: Effect.succeed(new Map([["C1", "team"]])),
  refresh: Effect.die("the Slack service must not refresh channels directly"),
});

const run = <A, E>(
  effect: (slack: Slack["Service"]) => Effect.Effect<A, E>,
  api: ReturnType<typeof stubApi>
) => {
  const users = UserDirectory.layer.pipe(Layer.provide(api.layer));
  const layer = Slack.layer.pipe(
    Layer.provide(api.layer),
    Layer.provide(channels),
    Layer.provide(users)
  );

  return Effect.gen(function* () {
    return yield* effect(yield* Slack);
  }).pipe(Effect.provide(layer), Effect.runPromise);
};

test("read filters thread replies, applies the limit, and uses payload authors", async () => {
  const api = stubApi({
    "conversations.view": [
      {
        ok: true,
        history: {
          messages: [
            { ts: "3.000000", user: "U1", text: "newer" },
            { ts: "2.000000", thread_ts: "1.000000", user: "U2", text: "reply" },
            { ts: "1.000000", user: "U2", text: "older" },
          ],
        },
        users: [
          { id: "U1", real_name: "First User" },
          { id: "U2", real_name: "Second User" },
        ],
      },
    ],
  });

  const view = await run((slack) => slack.read("team", 2), api);

  expect(view.channel).toBe("#team");
  expect(view.rows.map((row) => [row.author, row.message])).toEqual([
    ["Second User", "older"],
    ["First User", "newer"],
  ]);
  expect(api.calls).toEqual(["conversations.view"]);
});

test("activity hydrates a thread reply and resolves its author", async () => {
  const api = stubApi({
    "activity.feed": [
      {
        ok: true,
        items: [
          {
            is_unread: true,
            item: {
              type: "thread_v2",
              bundle_info: {
                payload: {
                  thread_entry: {
                    channel_id: "C1",
                    thread_ts: "1.000000",
                    latest_ts: "2.000000",
                    unread_msg_count: 2,
                  },
                },
              },
            },
          },
        ],
      },
    ],
    "conversations.replies": [
      { ok: true, messages: [{ ts: "2.000000", user: "U3", text: "done" }] },
    ],
    "users.info": [{ ok: true, user: { id: "U3", real_name: "Reply Author" } }],
  });

  const view = await run((slack) => slack.activity(20, "all"), api);

  expect(view.rows).toHaveLength(1);
  expect(view.rows[0]).toMatchObject({
    notification: "Thread reply (2 unread)",
    author: "Reply Author",
    message: "done",
    channel: "#team",
  });
  expect(api.calls).toEqual(["activity.feed", "conversations.replies", "users.info"]);
});

test("activity keeps only the mentions Alex has not replied to after, in their thread", async () => {
  const mention = (ts: string, threadTs: string | undefined) => ({
    is_unread: false,
    item: {
      type: "at_user",
      message: {
        channel: "C1",
        ts,
        ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
        author_user_id: "U2",
        text: `ping at ${ts}`,
      },
    },
  });
  const api = stubApi({
    "activity.feed": [
      {
        ok: true,
        items: [
          mention("1790000100.000000", "1790000000.000000"),
          mention("1790000200.000000", "1790000000.000000"),
          mention("1790000300.000000", undefined),
        ],
      },
    ],
    "auth.test": [{ ok: true, user_id: "UME", user: "me", team_id: "T1", team: "Team" }],
    "conversations.replies": [
      {
        ok: true,
        messages: [
          { ts: "1790000100.000000", user: "U2", text: "ping" },
          { ts: "1790000150.000000", user: "UME", text: "answered" },
        ],
      },
      {
        ok: true,
        messages: [{ ts: "1790000200.000000", user: "U2", text: "ping" }],
      },
      {
        ok: true,
        messages: [{ ts: "1790000300.000000", user: "U2", text: "ping" }],
      },
    ],
    "users.info": [{ ok: true, user: { id: "U2", real_name: "Lab" } }],
  });

  const view = await run(
    (slack) => slack.activity(20, "mentions", { unansweredOnly: true }),
    api
  );

  expect(view.rows.map((row) => row.message)).toEqual([
    "ping at 1790000200.000000",
    "ping at 1790000300.000000",
  ]);
  const threadReads = api.requests.filter((request) => request.method === "conversations.replies");
  expect(threadReads.map((request) => [request.params.ts, request.params.oldest])).toEqual([
    ["1790000000.000000", "1790000100.000000"],
    ["1790000000.000000", "1790000200.000000"],
    ["1790000300.000000", "1790000300.000000"],
  ]);
});

test("search uses the users returned with the result without another call", async () => {
  const api = stubApi({
    "search.messages": [
      {
        ok: true,
        messages: {
          total: 1,
          matches: [
            {
              ts: "1.000000",
              user: "U4",
              channel: { id: "C1", name: "team" },
              text: "hello <@U4>",
            },
          ],
        },
        users: { U4: { id: "U4", real_name: "Search Author" } },
      },
    ],
  });

  const view = await run((slack) => slack.search("hello", 20), api);

  expect(view.rows[0]).toMatchObject({ author: "Search Author", message: "hello @Search Author" });
  expect(api.calls).toEqual(["search.messages"]);
});

test("thread marks a partial Slack page as an incomplete total", async () => {
  const api = stubApi({
    "conversations.replies": [
      {
        ok: true,
        has_more: true,
        messages: [
          { ts: "1700000000.000000", user: "U1", text: "root" },
          { ts: "1700000001.000000", user: "U2", text: "older reply" },
          { ts: "1700000002.000000", user: "U3", text: "latest reply" },
        ],
      },
    ],
    "users.info": [
      { ok: true, user: { id: "U1", real_name: "Root" } },
      { ok: true, user: { id: "U3", real_name: "Latest" } },
    ],
  });

  const view = await run(
    (slack) =>
      slack.thread(
        threadTarget("C1:1700000000.000000"),
        1
      ),
    api
  );

  expect(view).toMatchObject({ total: 2, hasMore: true });
  expect(view.rows.map((row) => row.message)).toEqual(["root", "latest reply"]);
});

test("send resolves a channel and returns a reusable message link", async () => {
  const api = stubApi({
    "chat.postMessage": [
      { ok: true, channel: "C1", ts: "1700000000.000000" },
    ],
  });

  const view = await run((slack) => slack.send("team", "ship it"), api);

  expect(api.requests[0]).toMatchObject({
    method: "chat.postMessage",
    params: { channel: "C1", text: "ship it" },
  });
  expect(api.requests[0]?.params["client_msg_id"]).toMatch(UUID);
  expect(view).toEqual({
    channel: "#team",
    ts: "1700000000.000000",
    url: "https://app.slack.com/client/T1/C1/p1700000000000000",
  });
});

test("users matches any profile name field, skips deleted users, and emits mention syntax", async () => {
  const api = stubApi({
    "users.list": [
      {
        ok: true,
        members: [
          { id: "U1", name: "perry", is_bot: true, profile: { real_name: "Perry" } },
          { id: "U2", name: "gone", deleted: true, profile: { real_name: "Perry Gone" } },
          { id: "U3", name: "alex", profile: { display_name: "perry-fan" } },
          { id: "U4", name: "unrelated", profile: { real_name: "Someone Else" } },
        ],
      },
    ],
  });

  const view = await run((slack) => slack.users("perry", 20), api);

  expect(view.rows).toEqual([
    { id: "U1", mention: "<@U1>", handle: "perry", realName: "Perry", bot: true },
    { id: "U3", mention: "<@U3>", handle: "alex", realName: undefined, bot: false },
  ]);
  expect(api.calls).toEqual(["users.list"]);
});

test("users stops paging once the limit is satisfied", async () => {
  const api = stubApi({
    "users.list": [
      {
        ok: true,
        members: [{ id: "U1", name: "perry one" }],
        response_metadata: { next_cursor: "page2" },
      },
      {
        ok: true,
        members: [{ id: "U2", name: "perry two" }],
        response_metadata: { next_cursor: "page3" },
      },
    ],
  });

  const view = await run((slack) => slack.users("perry", 1), api);

  expect(view.rows.map((row) => row.id)).toEqual(["U1"]);
  expect(api.calls).toEqual(["users.list"]);
});

test("reply sends the root timestamp as thread_ts", async () => {
  const api = stubApi({
    "chat.postMessage": [
      { ok: true, channel: "C1", ts: "1700000002.000000" },
    ],
  });
  const target = threadTarget("C1:1700000000.000000");

  await run((slack) => slack.reply(target, "on it"), api);

  expect(api.requests[0]).toMatchObject({
    method: "chat.postMessage",
    params: { channel: "C1", text: "on it", thread_ts: "1700000000.000000" },
  });
  expect(api.requests[0]?.params["client_msg_id"]).toMatch(UUID);
});

const screenshot = {
  id: "F1",
  name: "screenshot.png",
  filetype: "png",
  mimetype: "image/png",
  size: 421_888,
  permalink: "https://workspace.slack.com/files/U1/F1/screenshot.png",
};

test("thread rows name the files of a file-only reply", async () => {
  const api = stubApi({
    "conversations.replies": [
      {
        ok: true,
        messages: [
          { ts: "1700000000.000000", user: "U1", text: "root" },
          { ts: "1700000001.000000", user: "U1", text: "", files: [screenshot] },
        ],
      },
    ],
    "users.info": [{ ok: true, user: { id: "U1", real_name: "Adam" } }],
  });

  const view = await run((slack) => slack.thread(threadTarget("C1:1700000000.000000"), 20), api);

  expect(view.rows[1]?.message).toBe("[file] screenshot.png (image/png, 412 KB)");
  expect(view.rows[1]?.files.map((file) => file.id)).toEqual(["F1"]);
});

test("activity reads the message behind a DM whose feed text is empty, files included", async () => {
  const api = stubApi({
    "activity.feed": [
      {
        ok: true,
        items: [
          {
            item: {
              type: "dm",
              bundle_info: {
                payload: {
                  dm_entry: {
                    latest_message: {
                      channel: "D1",
                      ts: "1700000001.000000",
                      author_user_id: "U1",
                      text: "",
                    },
                  },
                },
              },
            },
          },
        ],
      },
    ],
    "conversations.history": [
      { ok: true, messages: [{ ts: "1700000001.000000", user: "U1", text: "", files: [screenshot] }] },
    ],
    "users.info": [{ ok: true, user: { id: "U1", real_name: "Adam" } }],
  });

  const view = await run((slack) => slack.activity(20, "all"), api);

  expect(view.rows[0]?.message).toBe("[file] screenshot.png (image/png, 412 KB)");
  expect(view.rows[0]?.files.map((file) => file.id)).toEqual(["F1"]);
});

test("file reads the file's metadata, then downloads its private URL", async () => {
  const api = stubApi(
    {
      "files.info": [
        {
          ok: true,
          file: {
            ...screenshot,
            url_private_download: "https://files.slack.com/files-pri/T1-F1/download/screenshot.png",
          },
        },
      ],
    },
    {
      "https://files.slack.com/files-pri/T1-F1/download/screenshot.png": {
        body: "PNG-BYTES",
        contentType: "image/png",
      },
    }
  );

  const fetched = await run((slack) => slack.file("F1"), api);

  expect(fetched.file).toMatchObject({ id: "F1", name: "screenshot.png", kind: "file" });
  expect(new TextDecoder().decode(fetched.bytes)).toBe("PNG-BYTES");
  expect(api.requests[0]).toMatchObject({ method: "files.info", params: { file: "F1" } });
});

test("file text converts a canvas to plain text", async () => {
  const api = stubApi(
    {
      "files.info": [
        {
          ok: true,
          file: {
            id: "F2",
            title: "Huddle notes",
            filetype: "quip",
            url_private: "https://files.slack.com/files-pri/T1-F2/canvas",
          },
        },
      ],
    },
    {
      "https://files.slack.com/files-pri/T1-F2/canvas": {
        body: "<h1>Huddle notes</h1><p>Ship it.</p>",
        contentType: "text/html",
      },
    }
  );

  const text = await run((slack) => slack.fileText("F2"), api);

  expect(text.text).toBe("Huddle notes\n\nShip it.");
});

test("file fails with a re-login hint when Slack answers an image request with a sign-in page", async () => {
  const api = stubApi(
    {
      "files.info": [
        {
          ok: true,
          file: { ...screenshot, url_private: "https://files.slack.com/files-pri/T1-F1/screenshot.png" },
        },
      ],
    },
    {
      "https://files.slack.com/files-pri/T1-F1/screenshot.png": {
        body: "<!DOCTYPE html><title>Slack</title>",
        contentType: "text/html; charset=utf-8",
      },
    }
  );

  const outcome = await run((slack) => Effect.result(slack.file("F1")), api);

  expect(outcome._tag).toBe("Failure");
  if (outcome._tag === "Failure") expect(outcome.failure._tag).toBe("SlackAuthExpired");
});

const huddleRoot = (files: ReadonlyArray<string>) => ({
  ts: "1791301348.609899",
  user: "U1",
  subtype: "huddle_thread",
  text: "",
  room: {
    id: "R1",
    date_start: 1791301348,
    date_end: 1791303868,
    has_ended: true,
    participant_history: ["U1", "U2"],
    attached_file_ids: files,
  },
});

test("huddle prints attendees, duration, the AI notes and the transcript of a huddle thread", async () => {
  const api = stubApi(
    {
      "conversations.replies": [
        {
          ok: true,
          messages: [
            huddleRoot(["F0C77BN7ZJ5", "F0C73ERJ2LW"]),
            {
              ts: "1791303900.000100",
              user: "U1",
              text: "",
              files: [
                {
                  id: "F0C77BN7ZJ5",
                  title: "Huddle notes: 10/6/26 in #proj-ori",
                  filetype: "quip",
                  url_private: "https://files.slack.com/files-pri/T1-F0C77BN7ZJ5/canvas",
                },
              ],
            },
          ],
        },
      ],
      "files.info": [
        {
          ok: true,
          file: {
            id: "F0C77BN7ZJ5",
            title: "Huddle notes: 10/6/26 in #proj-ori",
            filetype: "quip",
            url_private: "https://files.slack.com/files-pri/T1-F0C77BN7ZJ5/canvas",
          },
        },
        {
          ok: true,
          file: {
            id: "F0C73ERJ2LW",
            title: "Huddle transcript",
            filetype: "huddle_transcript",
            url_private: "https://files.slack.com/files-pri/T1-F0C73ERJ2LW/huddle_transcript",
          },
        },
      ],
      "users.info": [
        { ok: true, user: { id: "U1", real_name: "Alex" } },
        { ok: true, user: { id: "U2", real_name: "Lab" } },
      ],
    },
    {
      "https://files.slack.com/files-pri/T1-F0C77BN7ZJ5/canvas": {
        body: "<h1>Summary</h1><p>Ship the hook.</p>",
        contentType: "text/html",
      },
      "https://files.slack.com/files-pri/T1-F0C73ERJ2LW/huddle_transcript": {
        body: JSON.stringify({ segments: [{ start_time: 20, speaker: "@lab", text: "Hi" }] }),
        contentType: "application/json",
      },
    }
  );

  const view = await run((slack) => slack.huddle(threadTarget("C1:1791301348.609899")), api);

  expect(view.isHuddle).toBe(true);
  expect(view.attendees).toEqual(["Alex", "Lab"]);
  expect(view.durationSeconds).toBe(2520);
  expect(view.notes?.text).toBe("Summary\n\nShip the hook.");
  expect(view.transcript?.text).toBe("0:20 @lab: Hi");
  expect(view.missing).toEqual([]);
});

test("huddle says which part is missing when a huddle left no AI notes", async () => {
  const api = stubApi({
    "conversations.replies": [{ ok: true, messages: [huddleRoot([])] }],
    "users.info": [
      { ok: true, user: { id: "U1", real_name: "Alex" } },
      { ok: true, user: { id: "U2", real_name: "Lab" } },
    ],
  });

  const view = await run((slack) => slack.huddle(threadTarget("C1:1791301348.609899")), api);

  expect(view.notes).toBeUndefined();
  expect(view.transcript).toBeUndefined();
  expect(view.missing).toEqual(["AI notes", "transcript"]);
});

test("huddle on an ordinary thread says it is not a huddle", async () => {
  const api = stubApi({
    "conversations.replies": [
      { ok: true, messages: [{ ts: "1700000000.000000", user: "U1", text: "just a thread" }] },
    ],
  });

  const view = await run((slack) => slack.huddle(threadTarget("C1:1700000000.000000")), api);

  expect(view.isHuddle).toBe(false);
});

const searchPageOf = (page: number, pages: number, perPage: number) => ({
  ok: true,
  messages: {
    total: pages * perPage,
    paging: { pages },
    matches: Array.from({ length: perPage }, (_, index) => ({
      ts: `${1790000000 - page * 1000 - index}.000000`,
      username: "alex",
      channel: { id: "C1", name: "team" },
      text: `match ${page}.${index}`,
    })),
  },
});

test("search reads Slack's pages until the limit, 20 matches a page as a session token gets them", async () => {
  const api = stubApi({
    "search.messages": [searchPageOf(1, 3, 20), searchPageOf(2, 3, 20), searchPageOf(3, 3, 20)],
  });

  const view = await run((slack) => slack.search("from:me", 50), api);

  expect(view.rows).toHaveLength(50);
  expect(view.total).toBe(60);
  expect(api.requests.map((request) => [request.params["page"], request.params["count"]])).toEqual([
    [1, 100],
    [2, 100],
    [3, 100],
  ]);
});

test("search stops at Slack's last page when the limit is larger than the results", async () => {
  const api = stubApi({
    "search.messages": [searchPageOf(1, 3, 20), searchPageOf(2, 3, 20), searchPageOf(3, 3, 20)],
  });

  const view = await run((slack) => slack.search("from:me", 1000), api);

  expect(view.rows).toHaveLength(60);
  expect(api.calls).toEqual(["search.messages", "search.messages", "search.messages"]);
});

test("activity asks the feed for at most 50 items a page and only for what the limit still needs", async () => {
  const mention = (ts: string) => ({
    item: { type: "at_user", message: { channel: "C1", ts, author_user_id: "U2", text: `ping at ${ts}` } },
  });
  const page = (from: number, count: number, cursor?: string) => ({
    ok: true,
    items: Array.from({ length: count }, (_, index) => mention(`${1790000000 - from - index}.000000`)),
    ...(cursor === undefined ? {} : { response_metadata: { next_cursor: cursor } }),
  });
  const api = stubApi({
    "activity.feed": [page(0, 50, "c2"), page(50, 50, "c3")],
    "users.info": [{ ok: true, user: { id: "U2", real_name: "Pinger" } }],
  });

  const view = await run((slack) => slack.activity(70, "mentions"), api);

  expect(view.rows).toHaveLength(70);
  expect(api.requests.filter((request) => request.method === "activity.feed").map((request) => [request.params["limit"], request.params["cursor"]])).toEqual([
    [50, undefined],
    [20, "c2"],
  ]);
});
