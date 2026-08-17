import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { SlackApiFailure } from "../domain/errors.ts";
import { SlackApi } from "./slack-api.ts";
import { UserDirectory } from "./user-directory.ts";

/**
 * A stand-in for the Web API that counts the ids it was asked about, since the
 * point of the directory is how few of those calls happen.
 */
const stubApi = (options: { readonly fails?: ReadonlySet<string> } = {}) => {
  const asked: Array<string> = [];

  const layer = Layer.succeed(SlackApi)({
    call: (request) => {
      const id = String(request.params["user"]);
      asked.push(id);

      if (options.fails?.has(id)) {
        return Effect.fail(new SlackApiFailure({ method: request.method, slackError: "user_not_found" }));
      }

      return request.decode({ ok: true, user: { id, name: id.toLowerCase() } }).pipe(Effect.orDie);
    },
    workspaceRef: Effect.succeed("T1"),
    session: Effect.die("the directory must not read credentials"),
  });

  return { asked, layer };
};

const run = <A, E>(
  effect: (directory: UserDirectory["Service"]) => Effect.Effect<A, E>,
  stub: ReturnType<typeof stubApi>
) =>
  Effect.gen(function* () {
    return yield* effect(yield* UserDirectory);
  }).pipe(
    Effect.provide(UserDirectory.layer.pipe(Layer.provide(stub.layer))),
    Effect.runPromise
  );

test("a name is fetched once, however many messages mention the person", async () => {
  const stub = stubApi();
  const names = await run(
    (directory) =>
      Effect.gen(function* () {
        yield* directory.names(["U1", "U2", "U1"]);
        return yield* directory.names(["U1", "U2"]);
      }),
    stub
  );

  expect(stub.asked).toEqual(["U1", "U2"]);
  expect(names).toEqual(
    new Map([
      ["U1", "u1"],
      ["U2", "u2"],
    ])
  );
});

test("people who arrived inside another payload are never looked up", async () => {
  const stub = stubApi();
  const names = await run(
    (directory) =>
      Effect.gen(function* () {
        yield* directory.seed([{ id: "U1", real_name: "Example User" }]);
        return yield* directory.names(["U1", "U2"]);
      }),
    stub
  );

  expect(stub.asked).toEqual(["U2"]);
  expect(names.get("U1")).toBe("Example User");
});

test("an author the token cannot read keeps its id and the rest of the list", async () => {
  const stub = stubApi({ fails: new Set(["U2"]) });
  const names = await run((directory) => directory.names(["U1", "U2"]), stub);

  expect(names).toEqual(
    new Map([
      ["U1", "u1"],
      ["U2", "U2"],
    ])
  );
});
