import { expect, test } from "bun:test";
import { Result } from "effect";

import { parseMessageTarget, parseThreadTarget, permalink } from "./thread-target.ts";

/** Compares the addresses as plain strings, since the domain type is branded. */
const parsed = (value: string): { channel: string; threadTs: string } => {
  const target = Result.getOrThrow(parseThreadTarget(value));
  return { channel: target.channel, threadTs: target.threadTs };
};

test("reads a thread address out of the link a person can actually copy", () => {
  expect(
    parsed(
      "https://workspace.invalid/archives/C00000001/p1700000001000001?thread_ts=1700000000.000001&cid=C00000001"
    )
  ).toEqual({ channel: "C00000001", threadTs: "1700000000.000001" });
});

test("falls back to the linked message when the link carries no thread root", () => {
  expect(parsed("https://workspace.invalid/archives/C00000002/p1700000002000002")).toEqual({
    channel: "C00000002",
    threadTs: "1700000002.000002",
  });
});

test("accepts the in-app thread URL", () => {
  expect(
    parsed(
      "https://app.slack.com/client/E00000001/C00000002/thread/C00000002-1700000003.000003"
    )
  ).toEqual({ channel: "C00000002", threadTs: "1700000003.000003" });
});

test("accepts the explicit channel and timestamp pair", () => {
  expect(parsed("C00000002:1700000003.000003")).toEqual({
    channel: "C00000002",
    threadTs: "1700000003.000003",
  });
});

test("refuses a link that addresses no thread", () => {
  const result = parseThreadTarget("https://app.slack.com/client/E00000001/C00000002");

  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure._tag).toBe("ThreadTargetInvalid");
  }
});

test("a channel link without a thread is not silently treated as a thread", () => {
  expect(Result.isFailure(parseThreadTarget("#project-alpha"))).toBe(true);
});

test("permalinks drop the dot from the timestamp", () => {
  expect(permalink("T00000001", "C00000001", "1700000000.000001")).toBe(
    "https://app.slack.com/client/T00000001/C00000001/p1700000000000001"
  );
});

test("parses the in-app link of a focused message", () => {
  expect(parsed("https://app.slack.com/client/E00000001/C00000001/p1700000004000004")).toEqual({
    channel: "C00000001",
    threadTs: "1700000004.000004",
  });
});

test("a permalink this tool prints can be pasted back into it", () => {
  const url = permalink("T00000001", "C00000001", "1700000004.000004");

  expect(parsed(url)).toEqual({ channel: "C00000001", threadTs: "1700000004.000004" });
});

test("an edit target keeps the linked reply, not the thread root", () => {
  const target = Result.getOrThrow(
    parseMessageTarget(
      "https://workspace.invalid/archives/C00000001/p1700000001000001?thread_ts=1700000000.000001&cid=C00000001"
    )
  );
  expect({ channel: String(target.channel), ts: String(target.ts) }).toEqual({
    channel: "C00000001",
    ts: "1700000001.000001",
  });
});

test("an edit target accepts the in-app link this tool prints", () => {
  const target = Result.getOrThrow(
    parseMessageTarget("https://app.slack.com/client/E00000001/C00000002/p1700000004000004")
  );
  expect({ channel: String(target.channel), ts: String(target.ts) }).toEqual({
    channel: "C00000002",
    ts: "1700000004.000004",
  });
});
