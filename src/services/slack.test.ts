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

const stubApi = (answers: Readonly<Record<string, ReadonlyArray<unknown>>>) => {
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
