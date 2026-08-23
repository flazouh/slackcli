import { Redacted, Schema } from "effect";

import type { TokenScope } from "./token-scope.ts";

const RedactedString = Schema.RedactedFromValue(Schema.String);

/**
 * A session credential: the `xoxc-` tokens the Slack web client holds plus the
 * `d` cookie that authorises them. Enterprise Grid issues two tokens with
 * different reach, so both are kept.
 */
const SessionAuth = Schema.Struct({
  kind: Schema.Literal("session"),
  workspaceToken: RedactedString,
  orgToken: Schema.optionalKey(RedactedString),
  cookie: RedactedString,
});

/**
 * An OAuth credential (`xoxp-` user token or `xoxb-` bot token). It carries its
 * own authority, so it needs no cookie.
 */
const BearerAuth = Schema.Struct({
  kind: Schema.Literal("bearer"),
  token: RedactedString,
});

export const SlackAuth = Schema.Union([SessionAuth, BearerAuth]).pipe(
  Schema.toTaggedUnion("kind")
);
export type SlackAuth = typeof SlackAuth.Type;

export const SlackSession = Schema.Struct({
  /** API host, for example `acme.slack.com`. */
  host: Schema.String,
  /**
   * Workspace id (`T…`). Optional because a credential supplied by hand may not
   * carry it; `auth.test` resolves it on first use in that case.
   */
  workspaceId: Schema.optionalKey(Schema.String),
  /** Org id (`E…`) on Enterprise Grid. Absent on a single workspace. */
  orgId: Schema.optionalKey(Schema.String),
  auth: SlackAuth,
}).annotate({ identifier: "SlackSession" });
export type SlackSession = typeof SlackSession.Type;

/**
 * The id Slack puts in a `/client/<id>/…` link. On Enterprise Grid that is the
 * org id; on a single workspace it is the team id.
 */
export const workspaceRef = (session: SlackSession): string | undefined =>
  session.orgId ?? session.workspaceId;

/**
 * The tokens to try for a method, best first.
 *
 * On Enterprise Grid neither token answers everything: the workspace token
 * fails org-wide reads with `team_is_restricted`, and the org token fails
 * `users.conversations` with `enterprise_is_restricted`. Trying the preferred
 * one and then the other is what makes both work, so the order is domain data.
 */
export const tokenCandidates = (
  auth: SlackAuth,
  scope: TokenScope
): ReadonlyArray<Redacted.Redacted<string>> => {
  if (auth.kind === "bearer") return [auth.token];

  const ordered =
    scope === "org"
      ? [auth.orgToken, auth.workspaceToken]
      : [auth.workspaceToken, auth.orgToken];

  const seen = new Set<string>();
  const candidates: Array<Redacted.Redacted<string>> = [];
  for (const token of ordered) {
    if (token === undefined) continue;
    const raw = Redacted.value(token);
    if (seen.has(raw)) continue;
    seen.add(raw);
    candidates.push(token);
  }
  return candidates;
};

/**
 * Session credentials only work with the browser cookie alongside them. An
 * OAuth token must not send one.
 *
 * The stored value is usually the bare `xoxd-…` string, because that is what
 * the login prompt asks for. A cookie header needs the `d=` name in front of
 * it, and Slack answers `invalid_auth` without it, so the name is added here
 * unless the credential already carries it.
 */
export const cookieHeader = (auth: SlackAuth): string | undefined => {
  if (auth.kind !== "session") return undefined;
  const value = Redacted.value(auth.cookie);
  return value.startsWith("d=") ? value : `d=${value}`;
};
