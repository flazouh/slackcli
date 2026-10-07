import { expect, test } from "bun:test";

import type { MessageRow } from "../domain/rows.ts";
import { paintFor, renderHuddle, renderMessages, renderSince } from "./render.ts";

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
  files: [],
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

test("a huddle prints attendees, duration, notes and transcript, and names what is missing", () => {
  const output = renderHuddle(
    {
      channel: "#proj-ori",
      url: "https://app.slack.com/client/E1/C1/p1791301348609899",
      isHuddle: true,
      attendees: ["Alex", "Lab"],
      startedAt: "2026-10-06T10:22:28.000Z",
      durationSeconds: 2520,
      ended: true,
      notes: undefined,
      transcript: {
        file: {
          id: "F0C73ERJ2LW",
          kind: "transcript",
          name: undefined,
          title: "Huddle transcript",
          filetype: "huddle_transcript",
          mimetype: undefined,
          size: undefined,
          permalink: undefined,
        },
        text: "[00:20] Lab: Hi",
        lines: [{ at: "00:20", offsetSeconds: 20, speakerId: "U2", speaker: "Lab", text: "Hi" }],
      },
      missing: ["AI notes"],
    },
    options
  );

  expect(output).toContain("Attended: Alex, Lab");
  expect(output).toContain("Duration: 42 min");
  expect(output).toContain("AI notes: none in this thread");
  expect(output).toContain("Transcript (F0C73ERJ2LW, 1 line)\n[00:20] Lab: Hi");
});

test("since prints every row in full with its channel, and marks the user's own posts", () => {
  const long = "word ".repeat(200).trim();
  const output = renderSince(
    {
      since: "2026-10-06T09:00:00.000Z",
      until: "2026-10-06T12:00:00.000Z",
      cut: 3,
      rows: [
        {
          channel: "#proj-ori",
          channelId: "C1",
          thread: "https://app.slack.com/client/E1/C1/p1",
          url: "https://app.slack.com/client/E1/C1/p1",
          author: "Alex",
          authorId: "UME",
          mine: true,
          at: "2026-10-06T11:00:00.000Z",
          message: long,
          files: [],
        },
      ],
    },
    options
  );

  expect(output).toContain(long);
  expect(output).toContain("#proj-ori");
  expect(output).toContain("3 older messages cut");
});
