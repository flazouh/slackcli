import { chmodSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, test } from "bun:test";
import { Effect, Layer, Redacted } from "effect";

import { SlackSession } from "../domain/session.ts";
import { SlackCredentials, writeSession } from "./credentials.ts";

const storedSession = SlackSession.make({
  host: "stored.slack.com",
  auth: { kind: "bearer", token: Redacted.make("xoxp-stored") },
});

test("a stored session wins over environment credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "slackcli-credentials-"));
  const env = {
    XDG_CONFIG_HOME: root,
    SLACK_HOST: "environment.slack.com",
    SLACK_TOKEN: "xoxp-environment",
  };

  const path = await writeSession(storedSession, env).pipe(
    Effect.provide(NodeServices.layer),
    Effect.runPromise
  );
  const layer = SlackCredentials.layer(env).pipe(Layer.provide(NodeServices.layer));
  const session = await Effect.gen(function* () {
    return yield* (yield* SlackCredentials).session;
  }).pipe(Effect.provide(layer), Effect.runPromise);

  expect(session.host).toBe("stored.slack.com");
  expect(session.auth.kind === "bearer" ? Redacted.value(session.auth.token) : undefined).toBe(
    "xoxp-stored"
  );
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("rewriting a session repairs unsafe file permissions", async () => {
  const root = mkdtempSync(join(tmpdir(), "slackcli-credentials-"));
  const env = { XDG_CONFIG_HOME: root };
  const path = await writeSession(storedSession, env).pipe(
    Effect.provide(NodeServices.layer),
    Effect.runPromise
  );
  chmodSync(path, 0o644);

  await writeSession(storedSession, env).pipe(
    Effect.provide(NodeServices.layer),
    Effect.runPromise
  );

  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("a browser token without its cookie names the missing part", async () => {
  const root = mkdtempSync(join(tmpdir(), "slackcli-credentials-"));
  const layer = SlackCredentials.layer({
    XDG_CONFIG_HOME: root,
    SLACK_TOKEN: "xoxc-browser",
  }).pipe(Layer.provide(NodeServices.layer));

  const result = await Effect.gen(function* () {
    return yield* Effect.result((yield* SlackCredentials).session);
  }).pipe(Effect.provide(layer), Effect.runPromise);

  expect(result._tag === "Failure" ? result.failure : undefined).toMatchObject({
    _tag: "CredentialUnavailable",
    source: "stored session, environment",
  });
  expect(result._tag === "Failure" ? result.failure.detail : "").toContain(
    "SLACK_COOKIE must also be set"
  );
});
