import { expect, test } from "bun:test";
import { Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { CredentialUnavailable, explain } from "../domain/errors.ts";
import { SlackSession } from "../domain/session.ts";
import { SlackCredentials } from "./credentials.ts";
import { SlackApi, slackCall } from "./slack-api.ts";

interface Sent {
  readonly url: string;
  readonly token: string | undefined;
  readonly bearer: string | undefined;
  readonly cookie: string | undefined;
  readonly fields: URLSearchParams;
}

/**
 * The stub answers with the bodies given, in order, and records what Slack would
 * have received. A request beyond the last body is a defect: the test asked for
 * a call it did not describe.
 */
const recorder = (bodies: ReadonlyArray<unknown | string>) => {
  const sent: Array<Sent> = [];

  const layer = Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const body = request.body;
        const text = body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : "";
        const fields = new URLSearchParams(text);

        sent.push({
          url: request.url,
          token: fields.get("token") ?? undefined,
          bearer: request.headers["authorization"],
          cookie: request.headers["cookie"],
          fields,
        });

        const next = bodies[sent.length - 1];
        if (next === undefined) throw new Error(`Unexpected call ${sent.length} to ${request.url}`);

        return HttpClientResponse.fromWeb(
          request,
          new Response(typeof next === "string" ? next : JSON.stringify(next), {
            headers: { "content-type": "application/json" },
          })
        );
      })
    )
  );

  return { sent, layer };
};

const gridSession = SlackSession.make({
  host: "acme.slack.com",
  workspaceId: "T1",
  orgId: "E1",
  auth: {
    kind: "session",
    workspaceToken: Redacted.make("xoxc-workspace"),
    orgToken: Redacted.make("xoxc-org"),
    cookie: Redacted.make("d=abc"),
  },
});

const bearerSession = SlackSession.make({
  host: "slack.com",
  workspaceId: "T9",
  auth: { kind: "bearer", token: Redacted.make("xoxp-personal") },
});

const Payload = Schema.Struct({ ok: Schema.Boolean, channel: Schema.optionalKey(Schema.String) });

const run = <A, E>(
  effect: (api: SlackApi["Service"]) => Effect.Effect<A, E>,
  bodies: ReadonlyArray<unknown | string>,
  session: SlackSession = gridSession
) => {
  const stub = recorder(bodies);
  const layer = SlackApi.layer.pipe(
    Layer.provide(SlackCredentials.layerFromSession(session)),
    Layer.provide(stub.layer)
  );

  const result = Effect.gen(function* () {
    const api = yield* SlackApi;
    return yield* Effect.result(effect(api));
  }).pipe(Effect.provide(layer), Effect.runPromise);

  return result.then((value) => ({ result: value, sent: stub.sent }));
};

test("a session token travels in the body with its cookie, never as a bearer", async () => {
  const { result, sent } = await run(
    (api) => api.call(slackCall("conversations.history", { channel: "C1", limit: 2 }, Payload)),
    [{ ok: true, channel: "C1" }]
  );

  expect(result._tag).toBe("Success");
  expect(sent).toHaveLength(1);
  expect(sent[0]?.url).toBe("https://acme.slack.com/api/conversations.history");
  expect(sent[0]?.token).toBe("xoxc-workspace");
  expect(sent[0]?.bearer).toBeUndefined();
  expect(sent[0]?.cookie).toBe("d=abc");
  expect(sent[0]?.fields.get("channel")).toBe("C1");
  expect(sent[0]?.fields.get("limit")).toBe("2");
});

test("an OAuth token travels as a bearer header, with no cookie and no body token", async () => {
  const { sent } = await run(
    (api) => api.call(slackCall("auth.test", {}, Payload)),
    [{ ok: true }],
    bearerSession
  );

  expect(sent[0]?.bearer).toBe("Bearer xoxp-personal");
  expect(sent[0]?.token).toBeUndefined();
  expect(sent[0]?.cookie).toBeUndefined();
});

test("a non-Slack host cannot receive a credential", async () => {
  const { result, sent } = await run(
    (api) => api.call(slackCall("auth.test", {}, Payload)),
    [],
    SlackSession.make({
      host: "slack.com.example.test",
      auth: { kind: "bearer", token: Redacted.make("xoxp-personal") },
    })
  );

  expect(result._tag === "Failure" ? result.failure : undefined).toMatchObject({
    _tag: "CredentialUnavailable",
    source: "Slack host",
  });
  expect(sent).toHaveLength(0);
});

test("a GovSlack host can receive its credential", async () => {
  const { result, sent } = await run(
    (api) => api.call(slackCall("auth.test", {}, Payload)),
    [{ ok: true }],
    SlackSession.make({
      host: "agency.slack-gov.com",
      auth: { kind: "bearer", token: Redacted.make("xoxp-personal") },
    })
  );

  expect(result._tag).toBe("Success");
  expect(sent[0]?.url).toBe("https://agency.slack-gov.com/api/auth.test");
});

test("a wrong-scope refusal is retried with the other token", async () => {
  const { result, sent } = await run(
    (api) => api.call(slackCall("conversations.history", { channel: "C1" }, Payload)),
    [{ ok: false, error: "team_is_restricted" }, { ok: true, channel: "C1" }]
  );

  expect(result._tag).toBe("Success");
  expect(sent.map((call) => call.token)).toEqual(["xoxc-workspace", "xoxc-org"]);
});

test("an org-wide method asks for the org token first", async () => {
  const { sent } = await run(
    (api) => api.call(slackCall("activity.feed", {}, Payload)),
    [{ ok: true }]
  );

  expect(sent[0]?.token).toBe("xoxc-org");
});

test("both tokens refused means the caller sees Slack's own reason", async () => {
  const { result, sent } = await run(
    (api) => api.call(slackCall("conversations.history", { channel: "C1" }, Payload)),
    [{ ok: false, error: "team_is_restricted" }, { ok: false, error: "channel_not_found" }]
  );

  expect(sent).toHaveLength(2);
  expect(result._tag === "Failure" ? result.failure : undefined).toMatchObject({
    _tag: "SlackApiFailure",
    slackError: "channel_not_found",
  });
});

test("an expired credential is not retried with the other token", async () => {
  const { result, sent } = await run(
    (api) => api.call(slackCall("conversations.history", { channel: "C1" }, Payload)),
    [{ ok: false, error: "invalid_auth" }]
  );

  expect(sent).toHaveLength(1);
  expect(result._tag === "Failure" ? result.failure._tag : undefined).toBe("SlackAuthExpired");
});

test("a payload Slack changed shape on fails as an invalid response, not a crash", async () => {
  const privateValue = "never-print-this-private-value";
  const { result } = await run(
    (api) =>
      api.call(
        slackCall("conversations.history", {}, Schema.Struct({ channel: Schema.Number }))
      ),
    [{ ok: true, channel: privateValue }]
  );

  const failure = result._tag === "Failure" ? result.failure : undefined;
  expect(failure?._tag).toBe("SlackResponseInvalid");
  expect(failure?._tag === "SlackResponseInvalid" ? failure.detail : "").not.toContain(
    privateValue
  );
});

test("an HTML error page fails as an invalid response", async () => {
  const { result } = await run(
    (api) => api.call(slackCall("conversations.history", {}, Payload)),
    ["<html>gateway timeout</html>"]
  );

  expect(result._tag === "Failure" ? result.failure : undefined).toMatchObject({
    _tag: "SlackResponseInvalid",
    method: "conversations.history",
  });
});

test("the workspace ref comes from the session without asking Slack", async () => {
  const { result, sent } = await run((api) => api.workspaceRef, []);

  expect(result._tag === "Success" ? result.success : undefined).toBe("E1");
  expect(sent).toHaveLength(0);
});

test("a session with no ids resolves the ref once and reuses it", async () => {
  const { result, sent } = await run(
    (api) => Effect.all([api.workspaceRef, api.workspaceRef]),
    [{ ok: true, user_id: "U5", team_id: "T5", enterprise_id: "E5" }],
    SlackSession.make({
      host: "slack.com",
      auth: { kind: "bearer", token: Redacted.make("xoxp-personal") },
    })
  );

  expect(result._tag === "Success" ? result.success : undefined).toEqual(["E5", "E5"]);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.url).toBe("https://slack.com/api/auth.test");
});

test("missing credentials stay a credential error with a login action", async () => {
  const stub = recorder([]);
  const credentials = Layer.succeed(SlackCredentials)({
    session: Effect.fail(
      new CredentialUnavailable({
        source: "stored session, environment",
        detail: "no session file; SLACK_TOKEN is not set",
      })
    ),
  });
  const layer = SlackApi.layer.pipe(Layer.provide(credentials), Layer.provide(stub.layer));

  const result = await Effect.gen(function* () {
    const api = yield* SlackApi;
    return yield* Effect.result(api.call(slackCall("auth.test", {}, Payload)));
  }).pipe(Effect.provide(layer), Effect.runPromise);

  expect(result._tag === "Failure" ? result.failure._tag : undefined).toBe(
    "CredentialUnavailable"
  );
  expect(result._tag === "Failure" ? explain(result.failure) : undefined).toContain(
    "run: slackcli login"
  );
  expect(stub.sent).toHaveLength(0);
});
