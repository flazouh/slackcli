#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";

import { slackcli } from "../cli/commands.ts";
import { explain } from "../domain/errors.ts";
import { ChannelDirectory } from "../services/channel-directory.ts";
import { SlackCredentials } from "../services/credentials.ts";
import { SlackApi } from "../services/slack-api.ts";
import { Slack } from "../services/slack.ts";
import { UserDirectory } from "../services/user-directory.ts";

const version = "0.1.0";

// `fetch` rather than undici: it is the one client that behaves the same on
// Node, Bun and Deno, and Bun's undici shim has no working Agent.
const api = SlackApi.layer.pipe(
  Layer.provide(SlackCredentials.layer()),
  Layer.provide(FetchHttpClient.layer)
);

/**
 * `provideMerge` rather than `provide`, because `refresh` uses the channel
 * directory directly and not only through the Slack service.
 */
const services = Slack.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(ChannelDirectory.layer(), UserDirectory.layer)),
  Layer.provideMerge(api),
  Layer.provideMerge(NodeServices.layer)
);

const main = Command.run(slackcli, { version }).pipe(
  // A terminal user gets one actionable line. Failures slackcli does not own are
  // already rendered by the CLI framework, so they pass through silently.
  Effect.tapError((error) => {
    const message = explain(error);
    return message === undefined ? Effect.void : Console.error(message);
  }),
  Effect.provide(services)
);

NodeRuntime.runMain(main, { disableErrorReporting: true });
