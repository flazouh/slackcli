import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { ChannelId } from "../domain/thread-target.ts";
import { ChannelDirectory } from "./channel-directory.ts";
import { Slack } from "./slack.ts";
import { SlackApi } from "./slack-api.ts";
import { UserDirectory } from "./user-directory.ts";

type Params = Readonly<Record<string, unknown>>;

/**
 * `since` reads many threads at once, so answers are routed by method and
 * parameters rather than by call order.
 */
const routedApi = (route: (method: string, params: Params) => unknown) => {
  const requests: Array<{ readonly method: string; readonly params: Params }> = [];
  const layer = Layer.succeed(SlackApi)({
    call: (request) => {
      requests.push({ method: request.method, params: request.params });
      const body = route(request.method, request.params);
      if (body === undefined) return Effect.die(`Unexpected call to ${request.method}`);
      return request.decode(body).pipe(Effect.orDie);
    },
    workspaceRef: Effect.succeed("E1"),
    session: Effect.die("the Slack service must not read credentials directly"),
    download: () => Effect.die("since must not download files"),
  });
  return { requests, layer };
};

const channels = Layer.succeed(ChannelDirectory)({
  resolve: () => Effect.succeed(ChannelId.make("C1")),
  names: Effect.succeed(new Map([["C1", "proj-ori"], ["C2", "agents-ori"]])),
  refresh: Effect.die("since must not refresh channels"),
});

const runSince = (api: ReturnType<typeof routedApi>, since: number, limit = 500) => {
  const users = UserDirectory.layer.pipe(Layer.provide(api.layer));
  const layer = Slack.layer.pipe(
    Layer.provide(api.layer),
    Layer.provide(channels),
    Layer.provide(users)
  );
  return Effect.gen(function* () {
    return yield* (yield* Slack).since(since, limit);
  }).pipe(Effect.provide(layer), Effect.runPromise);
};

const SINCE = 1791290000;
const names: Readonly<Record<string, string>> = { UME: "Alex", U2: "Adam", U3: "Lab", U4: "Chris" };

/**
 * Alex posted a top-level message in #proj-ori (Adam replied with a screenshot)
 * and a reply in an #agents-ori thread (Lab answered). Chris mentioned him in
 * another thread and sent a DM. One reply is older than the window.
 */
const workspace = (method: string, params: Params): unknown => {
  switch (method) {
    case "auth.test":
      return { ok: true, user_id: "UME", team_id: "T1" };
    case "users.info":
      return { ok: true, user: { id: params["user"], real_name: names[String(params["user"])] } };
    case "search.messages":
      return {
        ok: true,
        messages: {
          total: 2,
          matches: [
            {
              ts: "1791295000.000200",
              user: "UME",
              channel: { id: "C2", name: "agents-ori" },
              text: "Full text of my reply, which must not be cut at 130 characters, because the agent needs every word of what Alex said in the thread.",
              permalink: "https://x.slack.com/archives/C2/p1791295000000200?thread_ts=1791280000.000100",
            },
            {
              ts: "1791291000.000100",
              user: "UME",
              channel: { id: "C1", name: "proj-ori" },
              text: "Shipped the intern API",
              permalink: "https://x.slack.com/archives/C1/p1791291000000100",
            },
          ],
        },
      };
    case "activity.feed":
      return {
        ok: true,
        items: [
          {
            item: {
              type: "at_user",
              message: { channel: "C1", ts: "1791296000.000300", thread_ts: "1791100000.000100", author_user_id: "U4", text: "<@UME> can you check?" },
            },
          },
          {
            item: {
              type: "dm",
              bundle_info: {
                payload: { dm_entry: { latest_message: { channel: "D9", ts: "1791297000.000100", author_user_id: "U4", text: "ping" } } },
              },
            },
          },
          {
            item: {
              type: "at_user",
              message: { channel: "C1", ts: "1791000000.000100", author_user_id: "U4", text: "old mention" },
            },
          },
        ],
      };
    case "conversations.replies": {
      const key = `${params["channel"]}:${params["ts"]}`;
      const threads: Readonly<Record<string, ReadonlyArray<unknown>>> = {
        "C1:1791291000.000100": [
          { ts: "1791291000.000100", user: "UME", text: "Shipped the intern API", reply_count: 1 },
          { ts: "1791292000.000100", user: "U2", thread_ts: "1791291000.000100", text: "", files: [{ id: "F1", name: "shot.png", mimetype: "image/png", size: 2048 }] },
        ],
        "C2:1791280000.000100": [
          { ts: "1791280000.000100", user: "U3", text: "root before the window" },
          { ts: "1791295000.000200", user: "UME", thread_ts: "1791280000.000100", text: "Full text of my reply, which must not be cut at 130 characters, because the agent needs every word of what Alex said in the thread." },
          { ts: "1791298000.000100", user: "U3", thread_ts: "1791280000.000100", text: "Done, see <@UME>" },
        ],
        "C1:1791100000.000100": [
          { ts: "1791100000.000100", user: "U4", text: "old root" },
          { ts: "1791296000.000300", user: "U4", thread_ts: "1791100000.000100", text: "<@UME> can you check?" },
        ],
      };
      const messages = threads[key];
      return messages === undefined ? undefined : { ok: true, messages };
    }
    case "conversations.history":
      return params["channel"] === "D9"
        ? { ok: true, messages: [{ ts: "1791297000.000100", user: "U4", text: "ping" }] }
        : undefined;
    default:
      return undefined;
  }
};

test("since returns Alex's posts and everything others said around him, oldest first, in full", async () => {
  const api = routedApi(workspace);

  const view = await runSince(api, SINCE);

  expect(view.rows.map((row) => [row.channel, row.author, row.mine, row.message])).toEqual([
    ["#proj-ori", "Alex", true, "Shipped the intern API"],
    ["#proj-ori", "Adam", false, "[file] shot.png (image/png, 2 KB)"],
    [
      "#agents-ori",
      "Alex",
      true,
      "Full text of my reply, which must not be cut at 130 characters, because the agent needs every word of what Alex said in the thread.",
    ],
    ["#proj-ori", "Chris", false, "@Alex can you check?"],
    ["DM", "Chris", false, "ping"],
    ["#agents-ori", "Lab", false, "Done, see @Alex"],
  ]);
  expect(view.cut).toBe(0);
});

test("each since row links its thread and carries its files", async () => {
  const view = await runSince(routedApi(workspace), SINCE);
  const adam = view.rows.find((row) => row.author === "Adam");

  expect(adam?.thread).toBe("https://app.slack.com/client/E1/C1/p1791291000000100");
  expect(adam?.files.map((file) => file.id)).toEqual(["F1"]);
});

test("since keeps the newest rows over the limit and counts what it cut", async () => {
  const view = await runSince(routedApi(workspace), SINCE, 2);

  expect(view.rows.map((row) => row.author)).toEqual(["Chris", "Lab"]);
  expect(view.cut).toBe(4);
});

test("since searches only Alex's own recent posts", async () => {
  const api = routedApi(workspace);
  await runSince(api, SINCE);

  const search = api.requests.find((request) => request.method === "search.messages");
  expect(search?.params["query"]).toBe("from:me after:2026-10-04");
});
