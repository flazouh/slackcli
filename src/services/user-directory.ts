import { Cache, Context, Effect, Layer } from "effect";

import type { SlackCallError } from "../domain/errors.ts";
import type { PeopleIndex } from "../domain/message-text.ts";
import { displayName, UserInfoPayload } from "../domain/slack-schema.ts";
import type { SlackUser } from "../domain/slack-schema.ts";
import { SlackApi, slackCall } from "./slack-api.ts";

/**
 * How many `users.info` misses to run at once. Slack's per-method limit is about
 * fifty a minute, and the rate limiter already enforces that, so this only keeps
 * a single command from opening a connection per author.
 */
const LOOKUP_CONCURRENCY = 8;

export class UserDirectory extends Context.Service<
  UserDirectory,
  {
    /** Display names for the given ids, fetching only the ones not already known. */
    readonly names: (ids: Iterable<string>) => Effect.Effect<PeopleIndex>;
    /**
     * Records users that arrived inside another payload. `conversations.view` and
     * `search.messages` both return their authors, which is what makes those
     * commands a single round trip.
     */
    readonly seed: (users: ReadonlyArray<SlackUser>) => Effect.Effect<void>;
  }
>()("slackcli/UserDirectory") {
  static readonly layer: Layer.Layer<UserDirectory, never, SlackApi> = Layer.effect(
    UserDirectory
  )(
    Effect.gen(function* () {
      const api = yield* SlackApi;

      const cache = yield* Cache.make<string, string, SlackCallError>({
        capacity: 4096,
        lookup: (id) =>
          api
            .call(slackCall("users.info", { user: id }, UserInfoPayload))
            .pipe(Effect.map((payload) => displayName(payload.user))),
      });

      const names = Effect.fn("UserDirectory.names")(function* (ids: Iterable<string>) {
        const wanted = [...new Set(ids)].filter((id) => id.length > 0);
        const resolved = yield* Effect.forEach(
          wanted,
          (id) =>
            Cache.get(cache, id).pipe(
              // One unreadable author must not lose the whole message list, so a
              // failed lookup falls back to the raw id.
              Effect.catch(() => Effect.succeed(id)),
              Effect.map((name) => [id, name] as const)
            ),
          { concurrency: LOOKUP_CONCURRENCY }
        );

        return new Map(resolved) satisfies PeopleIndex;
      });

      const seed = (users: ReadonlyArray<SlackUser>): Effect.Effect<void> =>
        Effect.forEach(users, (user) => Cache.set(cache, user.id, displayName(user)), {
          discard: true,
        });

      return { names, seed };
    })
  );
}
