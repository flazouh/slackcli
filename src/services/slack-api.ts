import { Context, Duration, Effect, Layer, Redacted, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";
import { RateLimiter } from "effect/unstable/persistence";

import {
  CredentialUnavailable,
  SlackApiFailure,
  SlackAuthExpired,
  SlackRateLimited,
  SlackResponseInvalid,
  SlackTransportFailure,
} from "../domain/errors.ts";
import type { SlackCallError } from "../domain/errors.ts";
import { AuthTestPayload, ResponseEnvelope } from "../domain/slack-schema.ts";
import { cookieHeader, tokenCandidates, workspaceRef } from "../domain/session.ts";
import type { SlackSession } from "../domain/session.ts";
import { isExpiredCredential, isWrongTokenError, preferredScope } from "../domain/token-scope.ts";
import { SlackCredentials } from "./credentials.ts";

export type SlackParams = Readonly<Record<string, string | number | boolean | undefined>>;

/**
 * One Slack Web API method call, with the schema that its payload must satisfy.
 * Carrying a decoder rather than the schema itself keeps the service signature
 * free of schema generics.
 */
export interface SlackCall<A> {
  readonly method: string;
  readonly params: SlackParams;
  readonly decode: (value: unknown) => Effect.Effect<A, Schema.SchemaError>;
}

// Wire schemas decode without any service, which is what keeps `SlackApi.call`
// free of a requirement channel.
export const slackCall = <S extends Schema.Top & { readonly DecodingServices: never }>(
  method: string,
  params: SlackParams,
  payload: S
): SlackCall<S["Type"]> => ({
  method,
  params,
  decode: Schema.decodeUnknownEffect(payload),
});

const decodeEnvelope = Schema.decodeUnknownEffect(ResponseEnvelope);

const formFields = (params: SlackParams): Record<string, string> => {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    fields[key] = String(value);
  }
  return fields;
};

/**
 * The HTTP wrapper's own message is only "Transport error (POST …)", which tells
 * the user nothing they can act on. The reason and its cause are what name a
 * refused connection, an expired TLS chain or a DNS miss.
 *
 * A limiter that gives up after its own retries is the one case where the wait
 * is known, so it keeps its own error and its own wait hint.
 */
const sendFailure = (
  method: string,
  error: HttpClientError.HttpClientError | RateLimiter.RateLimiterError
): SlackTransportFailure | SlackRateLimited => {
  if (error._tag === "RateLimiterError") {
    return error.reason._tag === "RateLimitExceeded"
      ? new SlackRateLimited({
          method,
          retryAfterSeconds: Math.ceil(Duration.toMillis(error.reason.retryAfter) / 1000),
        })
      : new SlackTransportFailure({ method, detail: `rate limiter: ${error.reason._tag}` });
  }

  const because = error.cause;
  const detail =
    because instanceof Error ? `${error.reason._tag}: ${because.message}` : error.reason._tag;
  return new SlackTransportFailure({ method, detail });
};

/**
 * Slack's own limit is per method, so the limiter is keyed by URL. Tier 3 allows
 * roughly 50 calls a minute; staying just under it keeps bursts of concurrent
 * reads from earning a 429 in the first place.
 */
const RATE_LIMIT = { limit: 45, window: "1 minute" } as const;
const SLACK_HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*(?:slack\.com|slack-gov\.com)$/i;

/**
 * A bare client or one wearing the rate limiter, whose failures widen to include
 * the limiter's own. The two are not assignable to each other, so the error is a
 * parameter; `sendFailure` reads either one.
 */
type SlackTransportError = HttpClientError.HttpClientError | RateLimiter.RateLimiterError;

const sendWith = <A, E extends SlackTransportError>(
  client: HttpClient.HttpClient.With<E, never>,
  call: SlackCall<A>,
  session: SlackSession,
  token: Redacted.Redacted<string>
): Effect.Effect<A, SlackCallError> =>
  Effect.gen(function* () {
    if (!SLACK_HOST.test(session.host)) {
      return yield* new CredentialUnavailable({
        source: "Slack host",
        detail: `${session.host} is outside slack.com and slack-gov.com`,
      });
    }

    const cookie = cookieHeader(session.auth);
    const bearer = session.auth.kind === "bearer";

    const request = HttpClientRequest.post(`https://${session.host}/api/${call.method}`).pipe(
      HttpClientRequest.setHeaders({
        "user-agent": "slackcli/0.1.0",
        ...(cookie ? { cookie } : {}),
      }),
      bearer ? HttpClientRequest.bearerToken(Redacted.value(token)) : (self) => self,
      // The web client sends the session token as a body field, which is also
      // the only placement Slack accepts for a `xoxc-` token.
      HttpClientRequest.bodyUrlParams({
        ...formFields(call.params),
        ...(bearer ? {} : { token: Redacted.value(token) }),
      })
    );

    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError((cause) => sendFailure(call.method, cause)));

    const body = yield* response.json.pipe(
      Effect.mapError(
        () =>
          new SlackResponseInvalid({
            method: call.method,
            detail: `HTTP ${response.status} body was not JSON`,
          })
      )
    );

    // Slack reports failure inside a 200 response, so the envelope is always
    // decoded before the payload.
    const envelope = yield* decodeEnvelope(body).pipe(
      Effect.mapError(
        () =>
          new SlackResponseInvalid({
            method: call.method,
            detail: `HTTP ${response.status} body carried no ok field`,
          })
      )
    );

    if (!envelope.ok) {
      const slackError = envelope.error ?? "unknown_error";
      return yield* isExpiredCredential(slackError)
        ? new SlackAuthExpired({ slackError })
        : new SlackApiFailure({ method: call.method, slackError });
    }

    return yield* call
      .decode(body)
      .pipe(
        Effect.mapError(
          (cause) => new SlackResponseInvalid({ method: call.method, detail: cause.message })
        )
      );
  });

/**
 * One method call against one session, trying the next token when Slack says the
 * scope is wrong. It takes its client and session as arguments so that `login`,
 * which has to check a credential the user just typed, runs the same code path
 * as the service without rebuilding it: a Layer is memoised by reference, so
 * providing `SlackApi.layer` again would silently reuse the first credential.
 */
export const runCall = <A, E extends SlackTransportError>(
  client: HttpClient.HttpClient.With<E, never>,
  session: SlackSession,
  call: SlackCall<A>
): Effect.Effect<A, SlackCallError> => {
  const candidates = tokenCandidates(session.auth, preferredScope(call.method));

  const attempt = (index: number): Effect.Effect<A, SlackCallError> => {
    const token = candidates[index];
    if (token === undefined) {
      return Effect.fail(
        new SlackApiFailure({ method: call.method, slackError: "no_usable_token" })
      );
    }

    return sendWith(client, call, session, token).pipe(
      Effect.catchTag("SlackApiFailure", (failure) =>
        isWrongTokenError(failure.slackError) && index + 1 < candidates.length
          ? attempt(index + 1)
          : Effect.fail(failure)
      )
    );
  };

  return attempt(0);
};

export interface Downloaded {
  readonly bytes: Uint8Array;
  readonly contentType: string | undefined;
}

const DOWNLOAD = "file download";
const MAX_REDIRECTS = 3;

/**
 * Only an https URL on a Slack host may carry the session. A file's own URL
 * comes from Slack, but a redirect could point anywhere, so every hop is checked.
 */
const slackFileUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && SLACK_HOST.test(url.hostname) ? url : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Fetches a private file (`url_private`) the way the web client does: the
 * session cookie plus the token as a bearer header. Redirects are followed by
 * hand, because fetch would otherwise forward the cookie to whatever host a
 * redirect names.
 */
export const runDownload = <E extends SlackTransportError>(
  client: HttpClient.HttpClient.With<E, never>,
  session: SlackSession,
  url: string
): Effect.Effect<Downloaded, SlackCallError> => {
  const [token] = tokenCandidates(session.auth, "workspace");
  const cookie = cookieHeader(session.auth);

  const hop = (value: string, left: number): Effect.Effect<Downloaded, SlackCallError> =>
    Effect.gen(function* () {
      const target = slackFileUrl(value);
      if (target === undefined) {
        return yield* new SlackTransportFailure({
          method: DOWNLOAD,
          detail: `refused to send the Slack session to ${value}: not an https Slack URL`,
        });
      }

      const request = HttpClientRequest.get(target.toString()).pipe(
        HttpClientRequest.setHeaders({
          "user-agent": "slackcli/0.1.0",
          ...(cookie ? { cookie } : {}),
        }),
        token === undefined ? (self) => self : HttpClientRequest.bearerToken(Redacted.value(token))
      );

      const response = yield* client.execute(request).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.mapError((cause) => sendFailure(DOWNLOAD, cause))
      );

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers["location"];
        if (location === undefined || left === 0) {
          return yield* new SlackTransportFailure({
            method: DOWNLOAD,
            detail: `HTTP ${response.status} without a usable redirect`,
          });
        }
        return yield* hop(new URL(location, target).toString(), left - 1);
      }

      if (response.status >= 400) {
        return yield* new SlackApiFailure({ method: DOWNLOAD, slackError: `http_${response.status}` });
      }

      const body = yield* response.arrayBuffer.pipe(
        Effect.mapError((cause) => sendFailure(DOWNLOAD, cause))
      );
      return { bytes: new Uint8Array(body), contentType: response.headers["content-type"] };
    });

  return hop(url, MAX_REDIRECTS);
};

export class SlackApi extends Context.Service<
  SlackApi,
  {
    /** Runs one Web API method, retrying on the other token when scope is wrong. */
    readonly call: <A>(call: SlackCall<A>) => Effect.Effect<A, SlackCallError>;
    /** The id Slack uses in `/client/<id>/…` links, resolved once per process. */
    readonly workspaceRef: Effect.Effect<string, SlackCallError>;
    readonly session: Effect.Effect<SlackSession, SlackCallError>;
    /** Downloads one private Slack file with the session's credentials. */
    readonly download: (url: string) => Effect.Effect<Downloaded, SlackCallError>;
  }
>()("slackcli/SlackApi") {
  static readonly layer: Layer.Layer<
    SlackApi,
    never,
    SlackCredentials | HttpClient.HttpClient
  > = Layer.effect(SlackApi)(
    Effect.gen(function* () {
      const credentials = yield* SlackCredentials;
      const limiter = yield* RateLimiter.RateLimiter;

      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.retryTransient({ schedule: Schedule.exponential(200), times: 2 }),
        HttpClient.withRateLimiter({
          limiter,
          ...RATE_LIMIT,
          algorithm: "token-bucket",
          key: (request) => request.url,
          times: 3,
        })
      );

      const readSession = credentials.session;

      const call = Effect.fn("SlackApi.call")(function* <A>(request: SlackCall<A>) {
        return yield* runCall(client, yield* readSession, request);
      });

      const resolveWorkspaceRef = Effect.gen(function* () {
        const session = yield* readSession;
        const known = workspaceRef(session);
        if (known) return known;

        const auth = yield* call(slackCall("auth.test", {}, AuthTestPayload));
        return auth.enterprise_id ?? auth.team_id;
      });

      const download = Effect.fn("SlackApi.download")(function* (url: string) {
        return yield* runDownload(client, yield* readSession, url);
      });

      return {
        call,
        download,
        session: readSession,
        workspaceRef: yield* Effect.cached(resolveWorkspaceRef),
      };
    })
  ).pipe(Layer.provide(RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))));
}
