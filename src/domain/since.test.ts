import { expect, test } from "bun:test";
import { Result } from "effect";

import { parseSince, searchDay } from "./since.ts";

const now = new Date("2026-10-06T12:00:00.000Z");
const at = (value: string) => {
  const parsed = parseSince(value, now);
  return Result.isSuccess(parsed) ? new Date(parsed.success * 1000).toISOString() : "invalid";
};

test("a duration counts back from now", () => {
  expect(at("3h")).toBe("2026-10-06T09:00:00.000Z");
  expect(at("90m")).toBe("2026-10-06T10:30:00.000Z");
  expect(at("1d")).toBe("2026-10-05T12:00:00.000Z");
  expect(at("45s")).toBe("2026-10-06T11:59:15.000Z");
});

test("an ISO time is taken as it is", () => {
  expect(at("2026-10-06T08:15:00Z")).toBe("2026-10-06T08:15:00.000Z");
});

test("anything else is rejected", () => {
  expect(at("yesterday")).toBe("invalid");
  expect(at("3x")).toBe("invalid");
});

test("the search day starts early enough for any time zone, because Slack's after: is a local date", () => {
  expect(searchDay(Date.parse("2026-10-06T09:00:00Z") / 1000)).toBe("2026-10-04");
});
