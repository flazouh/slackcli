import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { SlackApi } from "./slack-api.ts";
import { ChannelDirectory } from "./channel-directory.ts";

test("a resolve-triggered refresh also updates the names view", async () => {
  let calls = 0;
  const api = Layer.succeed(SlackApi)({
    call: (request) => {
      calls += 1;
      const channels = calls === 1 ? [] : [{ id: "C0NEW1", name: "new-channel" }];
      return request.decode({ ok: true, channels }).pipe(Effect.orDie);
    },
    workspaceRef: Effect.succeed("T1"),
    session: Effect.die("the directory must not read credentials"),
  });
  const cacheHome = mkdtempSync(join(tmpdir(), "slackcli-channel-cache-"));
  const env = { XDG_CACHE_HOME: cacheHome };
  const layer = ChannelDirectory.layer(env).pipe(
    Layer.provide(api),
    Layer.provide(NodeServices.layer)
  );

  const result = await Effect.gen(function* () {
    const directory = yield* ChannelDirectory;
    const channel = yield* directory.resolve("new-channel");
    const names = yield* directory.names;
    return { channel, name: names.get(channel) };
  }).pipe(Effect.provide(layer), Effect.runPromise);

  expect(String(result.channel)).toBe("C0NEW1");
  expect(result.name).toBe("new-channel");
  expect(calls).toBe(2);
  expect(statSync(join(cacheHome, "slackcli/channels.json")).mode & 0o777).toBe(0o600);
});
