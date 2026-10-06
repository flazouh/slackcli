import { Data } from "effect";

/**
 * No usable Slack credential was found by any configured source.
 */
export class CredentialUnavailable extends Data.TaggedError("CredentialUnavailable")<{
  readonly source: string;
  readonly detail: string;
}> {}

/**
 * A credential was found but Slack rejected it. The fix is re-authentication,
 * not a retry, so it is a distinct tag from a transport failure.
 */
export class SlackAuthExpired extends Data.TaggedError("SlackAuthExpired")<{
  readonly slackError: string;
}> {}

/**
 * Slack answered `{ ok: false }` for a reason the caller may be able to act on.
 */
export class SlackApiFailure extends Data.TaggedError("SlackApiFailure")<{
  readonly method: string;
  readonly slackError: string;
}> {}

/**
 * Slack asked us to slow down. Carries the server's own wait hint.
 */
export class SlackRateLimited extends Data.TaggedError("SlackRateLimited")<{
  readonly method: string;
  readonly retryAfterSeconds: number;
}> {}

/**
 * The request never produced a Slack answer: DNS, TLS, socket, or a non-JSON body.
 */
export class SlackTransportFailure extends Data.TaggedError("SlackTransportFailure")<{
  readonly method: string;
  readonly detail: string;
}> {}

/**
 * Slack answered, but the body did not match the shape this version expects.
 */
export class SlackResponseInvalid extends Data.TaggedError("SlackResponseInvalid")<{
  readonly method: string;
  readonly detail: string;
}> {}

export class ChannelNotFound extends Data.TaggedError("ChannelNotFound")<{
  readonly name: string;
}> {}

export class ThreadTargetInvalid extends Data.TaggedError("ThreadTargetInvalid")<{
  readonly value: string;
}> {}

export class FileTargetInvalid extends Data.TaggedError("FileTargetInvalid")<{
  readonly value: string;
}> {}

export class SinceInvalid extends Data.TaggedError("SinceInvalid")<{
  readonly value: string;
}> {}

/**
 * A write was requested without `--yes`.
 */
export class WriteNotConfirmed extends Data.TaggedError("WriteNotConfirmed")<{
  readonly action: string;
}> {}

export type SlackCallError =
  | CredentialUnavailable
  | SlackApiFailure
  | SlackAuthExpired
  | SlackRateLimited
  | SlackResponseInvalid
  | SlackTransportFailure;

/** Every failure slackcli itself defines, and therefore owes the user a message for. */
type SlackcliError =
  | SlackCallError
  | ChannelNotFound
  | ThreadTargetInvalid
  | FileTargetInvalid
  | SinceInvalid
  | WriteNotConfirmed;

/**
 * The single line a terminal user should read for each failure. Every entry
 * names the next action, because an error with no next action just makes the
 * user run the command again. The mapped type is what proves a new error cannot
 * ship without a message.
 */
const MESSAGES: {
  readonly [Tag in SlackcliError["_tag"]]: (
    error: Extract<SlackcliError, { readonly _tag: Tag }>
  ) => string;
} = {
  CredentialUnavailable: (error) =>
    `No Slack credentials found (${error.source}: ${error.detail}). Set SLACK_TOKEN, or run: slackcli login`,
  SlackAuthExpired: (error) =>
    `Slack rejected the credential (${error.slackError}). Run: slackcli login`,
  SlackRateLimited: (error) =>
    `Slack is rate limiting ${error.method}. Retry in ${error.retryAfterSeconds}s.`,
  SlackApiFailure: (error) => `Slack refused ${error.method}: ${error.slackError}`,
  SlackTransportFailure: (error) => `Could not reach Slack for ${error.method}: ${error.detail}`,
  SlackResponseInvalid: (error) =>
    `Slack returned an unexpected shape for ${error.method}: ${error.detail}`,
  ChannelNotFound: (error) =>
    `No channel matches "${error.name}". If it is new, run: slackcli refresh`,
  ThreadTargetInvalid: (error) =>
    `Not a Slack thread reference: ${error.value}. Use a message link, or C0123ABC:1700000000.000100`,
  FileTargetInvalid: (error) =>
    `Not a Slack file reference: ${error.value}. Use a file id such as F0123ABCD, or the file's link`,
  SinceInvalid: (error) =>
    `Not a time: ${error.value}. Use a duration such as 3h, 90m or 1d, or an ISO time such as 2026-10-06T08:00:00Z`,
  WriteNotConfirmed: (error) =>
    `Nothing was sent. Re-run \`slackcli ${error.action}\` with --yes to post it.`,
};

const isSlackcliTag = (tag: string): tag is SlackcliError["_tag"] => tag in MESSAGES;

/**
 * Returns `undefined` for a failure slackcli does not own, such as an argument
 * parse error, which the CLI framework already reported in its own words.
 */
export const explain = (error: { readonly _tag: string }): string | undefined => {
  if (!isSlackcliTag(error._tag)) return undefined;

  // The tag guard establishes the arm; the map's own type keeps each writer honest.
  const write = MESSAGES[error._tag] as (value: { readonly _tag: string }) => string;
  return write(error);
};
