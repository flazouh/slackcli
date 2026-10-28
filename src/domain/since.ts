import { Result } from "effect";

import { DurationInvalid, SinceInvalid } from "./errors.ts";

const DURATION = /^(\d+(?:\.\d+)?)\s*([smhd])$/i;
const UNIT_SECONDS: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600, d: 86_400 };

/** A duration such as `6h`, `90m` or `1d`, in seconds. */
export const parseDuration = (value: string): Result.Result<number, DurationInvalid> => {
  const duration = DURATION.exec(value.trim());
  if (duration?.[1] === undefined || duration[2] === undefined) {
    return Result.fail(new DurationInvalid({ value }));
  }
  return Result.succeed(Number(duration[1]) * (UNIT_SECONDS[duration[2].toLowerCase()] ?? 0));
};

/**
 * The start of a `since` window, in Unix seconds: a duration counted back from
 * `now` (`3h`, `90m`, `1d`), or an ISO time. A bare date is refused, because
 * which midnight it means depends on a time zone the caller did not name.
 */
export const parseSince = (value: string, now: Date): Result.Result<number, SinceInvalid> => {
  const trimmed = value.trim();
  const duration = parseDuration(trimmed);
  if (Result.isSuccess(duration)) return Result.succeed(now.getTime() / 1000 - duration.success);
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return Result.succeed(parsed / 1000);
  }
  return Result.fail(new SinceInvalid({ value }));
};

/**
 * Slack's `after:` takes a date in the searcher's own time zone and excludes
 * that day. Two days back covers every zone; the exact cut is made locally.
 */
export const searchDay = (sinceSeconds: number): string =>
  new Date((sinceSeconds - 2 * 86_400) * 1000).toISOString().slice(0, 10);
