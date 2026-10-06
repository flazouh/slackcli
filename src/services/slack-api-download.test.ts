import { expect, test } from "bun:test";
import { Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { SlackSession } from "../domain/session.ts";
import { SlackCredentials } from "./credentials.ts";
import { SlackApi } from "./slack-api.ts";

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly bearer: string | undefined;
  readonly cookie: string | undefined;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Answers each request with the next response, recording what was sent. */
const recorder = (responses: ReadonlyArray<() => Response>) => {
  const sent: Array<Sent> = [];
  const layer = Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request) =>
      Effect.sync(() => {
        sent.push({
          url: request.url,
          method: request.method,
          bearer: request.headers["authorization"],
          cookie: request.headers["cookie"],
        });
        const next = responses[sent.length - 1];
        if (next === undefined) throw new Error(`Unexpected request to ${request.url}`);
        return HttpClientResponse.fromWeb(request, next());
      })
    )
  );
  return { sent, layer };
};

const session = SlackSession.make({
  host: "acme.slack.com",
  workspaceId: "T1",
  auth: {
    kind: "session",
    workspaceToken: Redacted.make("xoxc-workspace"),
    cookie: Redacted.make("d=abc"),
  },
});

const download = (url: string, responses: ReadonlyArray<() => Response>) => {
  const stub = recorder(responses);
  const layer = SlackApi.layer.pipe(
    Layer.provide(SlackCredentials.layerFromSession(session)),
    Layer.provide(stub.layer)
  );
  const result = Effect.gen(function* () {
    const api = yield* SlackApi;
    return yield* Effect.result(api.download(url));
  }).pipe(Effect.provide(layer), Effect.runPromise);
  return { sent: stub.sent, result };
};

test("download fetches a Slack file with the session cookie and token and returns its bytes", async () => {
  const { sent, result } = download("https://files.slack.com/files-pri/T1-F1/screenshot.png", [
    () => new Response(PNG, { headers: { "content-type": "image/png" } }),
  ]);
  const outcome = await result;

  expect(outcome._tag).toBe("Success");
  if (outcome._tag !== "Success") return;
  expect([...outcome.success.bytes]).toEqual([...PNG]);
  expect(outcome.success.contentType).toBe("image/png");
  expect(sent).toEqual([
    {
      url: "https://files.slack.com/files-pri/T1-F1/screenshot.png",
      method: "GET",
      bearer: "Bearer xoxc-workspace",
      cookie: "d=abc",
    },
  ]);
});

test("download refuses a host outside Slack before sending anything", async () => {
  const { sent, result } = download("https://evil.example.com/file.png", []);
  const outcome = await result;

  expect(outcome._tag).toBe("Failure");
  expect(sent).toEqual([]);
});

test("download follows a redirect inside Slack but never into another host", async () => {
  const inside = download("https://files.slack.com/files-pri/T1-F1/a.png", [
    () => new Response(null, { status: 302, headers: { location: "https://files.slack.com/files-tmb/T1-F1/a.png" } }),
    () => new Response(PNG, { headers: { "content-type": "image/png" } }),
  ]);
  expect((await inside.result)._tag).toBe("Success");
  expect(inside.sent.map((entry) => entry.url)).toEqual([
    "https://files.slack.com/files-pri/T1-F1/a.png",
    "https://files.slack.com/files-tmb/T1-F1/a.png",
  ]);

  const outside = download("https://files.slack.com/files-pri/T1-F1/a.png", [
    () => new Response(null, { status: 302, headers: { location: "https://cdn.example.com/a.png" } }),
  ]);
  expect((await outside.result)._tag).toBe("Failure");
  expect(outside.sent).toHaveLength(1);
});

test("download reports an HTTP error status as a failure", async () => {
  const { result } = download("https://files.slack.com/files-pri/T1-F1/a.png", [
    () => new Response("no", { status: 404 }),
  ]);

  expect((await result)._tag).toBe("Failure");
});
