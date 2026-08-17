import { homedir } from "node:os";

import { Context, Effect, FileSystem, Layer, Path, Redacted, Schema } from "effect";

import { CredentialUnavailable } from "../domain/errors.ts";
import { SlackSession } from "../domain/session.ts";

const SessionFile = Schema.fromJsonString(SlackSession);
const decodeSessionFile = Schema.decodeEffect(SessionFile);
const encodeSessionFile = Schema.encodeEffect(SessionFile);

export type EnvRecord = Readonly<Record<string, string | undefined>>;

const sessionDirectory = (env: EnvRecord = process.env): string => {
  const configHome = env["XDG_CONFIG_HOME"];
  return configHome && configHome.length > 0
    ? `${configHome}/slackcli`
    : `${env["HOME"] ?? homedir()}/.config/slackcli`;
};

const sessionPath = (env: EnvRecord = process.env): string =>
  `${sessionDirectory(env)}/session.json`;

const DEFAULT_HOST = "slack.com";

/**
 * A `xoxc-` token is only half a credential: it is authorised by the browser's
 * `d` cookie and is useless without it. Failing here with the exact missing
 * piece is far kinder than letting Slack answer `invalid_auth` later.
 */
const sessionFromEnv = (env: EnvRecord): Effect.Effect<SlackSession, CredentialUnavailable> =>
  Effect.gen(function* () {
    const token = env["SLACK_TOKEN"];
    if (!token) {
      return yield* new CredentialUnavailable({
        source: "environment",
        detail: "SLACK_TOKEN is not set",
      });
    }

    const host = env["SLACK_HOST"] ?? DEFAULT_HOST;
    const workspaceId = env["SLACK_WORKSPACE_ID"];
    const orgId = env["SLACK_ORG_ID"];
    const base = {
      host,
      ...(workspaceId ? { workspaceId } : {}),
      ...(orgId ? { orgId } : {}),
    };

    if (!token.startsWith("xoxc-")) {
      return SlackSession.make({
        ...base,
        auth: { kind: "bearer", token: Redacted.make(token) },
      });
    }

    const cookie = env["SLACK_COOKIE"];
    if (!cookie) {
      return yield* new CredentialUnavailable({
        source: "environment",
        detail: "SLACK_TOKEN is a browser session token, so SLACK_COOKIE must also be set",
      });
    }

    const orgToken = env["SLACK_ORG_TOKEN"];
    return SlackSession.make({
      ...base,
      auth: {
        kind: "session",
        workspaceToken: Redacted.make(token),
        ...(orgToken ? { orgToken: Redacted.make(orgToken) } : {}),
        cookie: Redacted.make(cookie),
      },
    });
  });

const sessionFromStore = (
  env: EnvRecord
): Effect.Effect<SlackSession, CredentialUnavailable, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = sessionPath(env);

    const text = yield* fs.readFileString(path).pipe(
      Effect.mapError(
        () =>
          new CredentialUnavailable({
            source: "stored session",
            detail: `no readable session at ${path}`,
          })
      )
    );

    return yield* decodeSessionFile(text).pipe(
      Effect.mapError(
        (cause) =>
          new CredentialUnavailable({
            source: "stored session",
            detail: `${path} is not a valid session file (${cause.message})`,
          })
      )
    );
  });

/**
 * Writes the session with owner-only permissions. The file holds a live Slack
 * credential, so the mode is part of the contract, not a nicety.
 */
export const writeSession = Effect.fn("SlackCredentials.writeSession")(function* (
  session: SlackSession,
  env: EnvRecord = process.env
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = sessionPath(env);

  yield* fs.makeDirectory(path.dirname(target), { recursive: true });
  const text = yield* encodeSessionFile(session);
  yield* fs.writeFileString(target, `${text}\n`, { mode: 0o600 });
  yield* fs.chmod(target, 0o600);
  return target;
});

export class SlackCredentials extends Context.Service<
  SlackCredentials,
  {
    readonly session: Effect.Effect<SlackSession, CredentialUnavailable>;
  }
>()("slackcli/SlackCredentials") {
  /** For tests and for a session resolved in-process, such as during login. */
  static readonly layerFromSession = (session: SlackSession): Layer.Layer<SlackCredentials> =>
    Layer.succeed(SlackCredentials)({ session: Effect.succeed(session) });

  /**
   * The stored session first, then the environment. Resolution is memoised, so
   * a command that makes several calls reads the credential once.
   */
  static readonly layer = (
    env: EnvRecord = process.env
  ): Layer.Layer<SlackCredentials, never, FileSystem.FileSystem> =>
    Layer.effect(SlackCredentials)(
      Effect.gen(function* () {
        // Closing over the file system here keeps it out of the service's
        // requirement channel, so callers only ever need SlackCredentials.
        const fs = yield* FileSystem.FileSystem;
        const resolve = sessionFromStore(env).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.catchTag("CredentialUnavailable", (stored) =>
            sessionFromEnv(env).pipe(
              Effect.catchTag(
                "CredentialUnavailable",
                (fromEnvironment) =>
                  new CredentialUnavailable({
                    source: "stored session, environment",
                    detail: `${stored.detail}; ${fromEnvironment.detail}`,
                  })
              )
            )
          )
        );

        return { session: yield* Effect.cached(resolve) };
      })
    );
}
