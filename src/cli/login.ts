import { Effect, Redacted } from "effect";
import { Prompt } from "effect/unstable/cli";
import { HttpClient } from "effect/unstable/http";

import type { SlackCallError } from "../domain/errors.ts";
import { SlackSession } from "../domain/session.ts";
import { AuthTestPayload } from "../domain/slack-schema.ts";
import { runCall, slackCall } from "../services/slack-api.ts";

export interface LoginInput {
  readonly host: string | undefined;
  readonly token: string | undefined;
  readonly cookie: string | undefined;
  readonly orgToken: string | undefined;
}

const HOST_HELP = "Slack host, as in acme.slack.com";

/**
 * Everything a session credential needs, asked for only when it was not passed
 * as a flag. The token and the cookie are read hidden, because a shell history
 * holding a live Slack credential is exactly what this command exists to avoid.
 */
export const collect = Effect.fn("login.collect")(function* (input: LoginInput) {
  const host =
    input.host ?? (yield* Prompt.text({ message: HOST_HELP, default: "slack.com" }));

  const token = input.token
    ? Redacted.make(input.token)
    : yield* Prompt.hidden({ message: "Token (xoxc-… from the browser, or xoxp-…)" });

  const raw = Redacted.value(token);
  if (!raw.startsWith("xoxc-")) {
    return SlackSession.make({ host, auth: { kind: "bearer", token } });
  }

  const cookie = input.cookie
    ? Redacted.make(input.cookie)
    : yield* Prompt.hidden({ message: "Cookie (the d=… value)" });

  const orgToken = input.orgToken;
  return SlackSession.make({
    host,
    auth: {
      kind: "session",
      workspaceToken: token,
      ...(orgToken ? { orgToken: Redacted.make(orgToken) } : {}),
      cookie,
    },
  });
});

export interface Verified {
  readonly user: string;
  readonly workspace: string;
  readonly session: SlackSession;
}

/**
 * A credential is only worth storing once Slack has accepted it. The call runs
 * against the typed-in session directly rather than through the `SlackApi`
 * service, which is already bound to whatever credential the process resolved.
 */
export const verify = (
  session: SlackSession
): Effect.Effect<Verified, SlackCallError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const identity = yield* runCall(client, session, slackCall("auth.test", {}, AuthTestPayload));

    return {
      user: identity.user ?? identity.user_id,
      workspace: identity.team ?? identity.team_id,
      // Slack knows the ids better than the person typing them, so the stored
      // session carries what auth.test just answered.
      session: SlackSession.make({
        ...session,
        workspaceId: identity.team_id,
        ...(identity.enterprise_id ? { orgId: identity.enterprise_id } : {}),
      }),
    };
  });
