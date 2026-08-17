import { expect, test } from "bun:test";

import type { MessageRow } from "../domain/rows.ts";
import { paintFor, renderMessages } from "./render.ts";

const options = {
  paint: paintFor(false),
  now: new Date("2026-08-17T12:00:00.000Z"),
  full: false,
};

const row = (message: string): MessageRow => ({
  author: "Example User",
  message,
  at: "2026-08-17T11:59:00.000Z",
  url: "https://example.com/message",
  replies: undefined,
});

test("a character-clamped message ends with one ellipsis", () => {
  const output = renderMessages("#team", [row("x".repeat(600))], options);

  expect(output.match(/…/g)).toHaveLength(1);
  expect(output).not.toContain("… …");
});

test("one hidden line uses the singular label", () => {
  const output = renderMessages("#team", [row("one\ntwo\nthree\nfour\nfive")], options);

  expect(output).toContain("… +1 line");
  expect(output).not.toContain("+1 lines");
});
