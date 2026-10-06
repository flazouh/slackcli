import { expect, test } from "bun:test";
import { Result } from "effect";

import { parseFileTarget, plainText } from "./file-text.ts";

const fileId = (value: string) => {
  const parsed = parseFileTarget(value);
  return Result.isSuccess(parsed) ? parsed.success : `invalid: ${parsed.failure.value}`;
};

test("a file id, a file permalink, a canvas link and a transcript link all resolve to the file id", () => {
  expect(fileId("F0C77BN7ZJ5")).toBe("F0C77BN7ZJ5");
  expect(fileId("https://openrouter.slack.com/files/U012AB/F0C73ERJ2LW/huddle_transcript")).toBe(
    "F0C73ERJ2LW"
  );
  expect(fileId("https://openrouter.slack.com/docs/T053YQ6R5TR/F0C77BN7ZJ5")).toBe("F0C77BN7ZJ5");
  expect(fileId("https://files.slack.com/files-pri/T053YQ6R5TR-F0C77BN7ZJ5/image.png")).toBe(
    "F0C77BN7ZJ5"
  );
});

test("a value with no file id is rejected", () => {
  expect(fileId("https://openrouter.slack.com/archives/C1/p1700000000000000")).toBe(
    "invalid: https://openrouter.slack.com/archives/C1/p1700000000000000"
  );
});

test("canvas HTML becomes plain text with headings, paragraphs and bullets on their own lines", () => {
  const html =
    "<html><head><style>p{}</style></head><body><h1>Huddle notes</h1><p>We agreed &amp; shipped.</p>" +
    "<ul><li>Alex: fix the hook</li><li>Lab: review</li></ul><p>Next&nbsp;week</p></body></html>";

  expect(plainText(html, "text/html")).toBe(
    "Huddle notes\n\nWe agreed & shipped.\n\n• Alex: fix the hook\n• Lab: review\n\nNext week"
  );
});

test("a JSON transcript becomes one timestamped line per segment", () => {
  const transcript = JSON.stringify({
    segments: [
      { start_time: 20, speaker: "@lab", text: "Can you hear me?" },
      { start_time: 75.4, speaker: "Alex", text: "Yes." },
    ],
  });

  expect(plainText(transcript, "application/json")).toBe("0:20 @lab: Can you hear me?\n1:15 Alex: Yes.");
});

test("a WebVTT transcript keeps the cue start and the words", () => {
  const vtt = "WEBVTT\n\n1\n00:00:20.000 --> 00:00:24.000\n<v @lab>Can you hear me?\n\n2\n00:01:15.000 --> 00:01:16.000\n<v Alex>Yes.\n";

  expect(plainText(vtt, "text/vtt")).toBe("0:20 @lab: Can you hear me?\n1:15 Alex: Yes.");
});

test("plain text passes through unchanged", () => {
  expect(plainText("0:20 @lab hello\n", "text/plain")).toBe("0:20 @lab hello");
});
