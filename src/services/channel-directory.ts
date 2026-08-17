import { homedir } from "node:os";

import { Context, Effect, FileSystem, Layer, Path, Ref, Schema } from "effect";

import { ChannelNotFound } from "../domain/errors.ts";
import type { SlackCallError } from "../domain/errors.ts";
import { ChannelId } from "../domain/thread-target.ts";
import { ConversationListPayload, SlackChannel } from "../domain/slack-schema.ts";
import { SlackApi, slackCall } from "./slack-api.ts";
import type { EnvRecord } from "./credentials.ts";

const CachedChannels = Schema.Struct({
  fetchedAt: Schema.Number,
  channels: Schema.Array(SlackChannel),
});

const CacheFile = Schema.fromJsonString(CachedChannels);
const decodeCache = Schema.decodeEffect(CacheFile);
const encodeCache = Schema.encodeEffect(CacheFile);

/**
 * Channel membership changes rarely, and re-listing it costs a round trip on
 * every command. Six hours keeps `read #channel` down to a single API call
 * without going stale enough to notice.
 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PAGE_SIZE = 1000;
const MAX_PAGES = 5;

const cachePath = (env: EnvRecord = process.env): string => {
  const cacheHome = env["XDG_CACHE_HOME"];
  const root =
    cacheHome && cacheHome.length > 0
      ? `${cacheHome}/slackcli`
      : `${env["HOME"] ?? homedir()}/.cache/slackcli`;
  return `${root}/channels.json`;
};

const listChannels = (
  api: SlackApi["Service"]
): Effect.Effect<ReadonlyArray<SlackChannel>, SlackCallError> => {
  const page = (
    cursor: string | undefined,
    seen: ReadonlyArray<SlackChannel>,
    remaining: number
  ): Effect.Effect<ReadonlyArray<SlackChannel>, SlackCallError> =>
    api
      .call(
        slackCall(
          "users.conversations",
          {
            types: "public_channel,private_channel,mpim,im",
            exclude_archived: true,
            limit: PAGE_SIZE,
            cursor,
          },
          ConversationListPayload
        )
      )
      .pipe(
        Effect.flatMap((payload) => {
          const collected = [...seen, ...payload.channels];
          const next = payload.response_metadata?.next_cursor;
          return next && next.length > 0 && remaining > 1
            ? page(next, collected, remaining - 1)
            : Effect.succeed(collected);
        })
      );

  return page(undefined, [], MAX_PAGES);
};

const isChannelId = Schema.is(ChannelId);

const namesOf = (channels: ReadonlyArray<SlackChannel>): ReadonlyMap<string, string> =>
  new Map(
    channels.flatMap((channel) => (channel.name ? [[channel.id, channel.name] as const] : []))
  );

export class ChannelDirectory extends Context.Service<
  ChannelDirectory,
  {
    /** Turns `#project-alpha`, `project-alpha`, or a raw `C…` id into a channel id. */
    readonly resolve: (
      reference: string
    ) => Effect.Effect<ChannelId, ChannelNotFound | SlackCallError>;
    /** Channel id to name, for rendering. */
    readonly names: Effect.Effect<ReadonlyMap<string, string>, SlackCallError>;
    /** Re-reads the channel list from Slack and rewrites the cache. */
    readonly refresh: Effect.Effect<ReadonlyMap<string, string>, SlackCallError>;
  }
>()("slackcli/ChannelDirectory") {
  static readonly layer = (
    env: EnvRecord = process.env
  ): Layer.Layer<ChannelDirectory, never, SlackApi | FileSystem.FileSystem | Path.Path> =>
    Layer.effect(ChannelDirectory)(
      Effect.gen(function* () {
        const api = yield* SlackApi;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = cachePath(env);

        const fetchAndStore: Effect.Effect<ReadonlyMap<string, string>, SlackCallError> =
          Effect.gen(function* () {
            const channels = yield* listChannels(api);

            // Encoding a value built one line earlier can only fail through a
            // bug, so it is a defect rather than an expected error. The write
            // itself is best effort: a missing cache must not fail a command
            // that already has its answer.
            const text = yield* Effect.orDie(encodeCache({ fetchedAt: Date.now(), channels }));
            yield* fs
              .makeDirectory(path.dirname(file), { recursive: true })
              .pipe(
                Effect.andThen(fs.writeFileString(file, `${text}\n`, { mode: 0o600 })),
                Effect.andThen(fs.chmod(file, 0o600)),
                Effect.ignore
              );

            return namesOf(channels);
          });

        // Absent, unreadable, malformed and stale are one case to the caller: ask
        // Slack. Only the freshness test is worth distinguishing here.
        const fromCache = Effect.gen(function* () {
          const cached = yield* decodeCache(yield* fs.readFileString(file));
          const fresh = Date.now() - cached.fetchedAt <= CACHE_TTL_MS;
          return fresh ? namesOf(cached.channels) : undefined;
        }).pipe(Effect.catch(() => Effect.succeed(undefined)));

        const state = yield* Ref.make<ReadonlyMap<string, string> | undefined>(undefined);
        const load = fromCache.pipe(
          Effect.flatMap((cached) =>
            cached === undefined ? fetchAndStore : Effect.succeed(cached)
          ),
          Effect.tap((loaded) => Ref.set(state, loaded))
        );
        const initial = yield* Effect.cached(load);
        const names = Ref.get(state).pipe(
          Effect.flatMap((current) => current === undefined ? initial : Effect.succeed(current))
        );
        const refresh = fetchAndStore.pipe(Effect.tap((fresh) => Ref.set(state, fresh)));

        const resolve = Effect.fn("ChannelDirectory.resolve")(function* (reference: string) {
          const wanted = reference.replace(/^#/, "");
          if (isChannelId(wanted)) return wanted;

          const found = (map: ReadonlyMap<string, string>): ChannelId | undefined => {
            for (const [id, name] of map) if (name === wanted) return ChannelId.make(id);
            return undefined;
          };

          const cached = found(yield* names);
          if (cached) return cached;

          // A channel joined since the cache was written is the common miss, so
          // one refresh is tried before reporting it as unavailable.
          const fresh = found(yield* refresh);
          if (fresh) return fresh;

          return yield* new ChannelNotFound({ name: wanted });
        });

        return { resolve, names, refresh };
      })
    );
}
