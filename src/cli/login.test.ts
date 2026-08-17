import { expect, test } from "bun:test";
import { Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { SlackSession } from "../domain/session.ts";
import { SlackCredentials } from "../services/credentials.ts";
import { SlackApi } from "../services/slack-api.ts";
import { verify } from "./login.ts";

const alreadySignedIn = SlackSession.make({
  host: "acme.slack.com",
  workspaceId: "T1",
  auth: { kind: "bearer", token: Redacted.make("xoxp-the-old-one") },
});

const typedIn = SlackSession.make({
  host: "new.slack.com",
  auth: { kind: "bearer", token: Redacted.make("xoxp-the-new-one") },
});

/**
 * A Layer is memoised by reference, so a login that rebuilt `SlackApi.layer`
 * around the typed-in credential would silently reuse the credential the process
 * already resolved, and store a token Slack never accepted. This runs `verify`
 * with the service present to prove it does not.
 */
test("login checks the credential it was given, not the one already in use", async () => {
  const seen: Array<{ readonly url: string; readonly bearer: string | undefined }> = [];

  const stub = Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request) => {
      seen.push({ url: request.url, bearer: request.headers["authorization"] });
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ ok: true, user_id: "U9", team_id: "T9", user: "new" }), {
            headers: { "content-type": "application/json" },
          })
        )
      );
    })
  );

  const program = verify(typedIn).pipe(
    Effect.provide(stub),
    Effect.provide(
      SlackApi.layer.pipe(
        Layer.provide(SlackCredentials.layerFromSession(alreadySignedIn)),
        Layer.provide(stub)
      )
    )
  );

  const verified = await Effect.runPromise(program);

  expect(seen).toEqual([
    { url: "https://new.slack.com/api/auth.test", bearer: "Bearer xoxp-the-new-one" },
  ]);
  expect(verified.user).toBe("new");
  // The ids come from Slack's answer, so the stored session is right even when
  // the person typing knew none of them.
  expect(verified.session.workspaceId).toBe("T9");
});
