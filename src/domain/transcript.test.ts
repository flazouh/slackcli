import { expect, test } from "bun:test";

import {
  mentionedUserIds,
  resolveMentions,
  transcriptClock,
  transcriptLines,
  transcriptSpeakerIds,
  transcriptText,
} from "./transcript.ts";

const people = new Map([
  ["U0AAAAAAAA1", "chris"],
  ["U0AAAAAAAA2", "david"],
]);

const transcription = {
  lines: [
    { contents: "Second.", start_time_ms: 75_500, user_id: "U0AAAAAAAA2" },
    { contents: "  First.  ", start_time_ms: 14_000, user_id: "U0AAAAAAAA1" },
    { contents: "", start_time_ms: 20_000, user_id: "U0AAAAAAAA1" },
    { contents: "Late.", start_time_ms: 3_725_000, user_id: "U0UNKNOWN99" },
    { contents: "Nobody.", start_time_ms: 3_726_000 },
  ],
};

test("transcript offsets read as mm:ss, and h:mm:ss past the hour", () => {
  expect(transcriptClock(0)).toBe("00:00");
  expect(transcriptClock(172.9)).toBe("02:52");
  expect(transcriptClock(3725)).toBe("1:02:05");
});

test("transcript lines come back in time order with speakers resolved and empty lines dropped", () => {
  expect(transcriptLines(transcription, people)).toEqual([
    { at: "00:14", offsetSeconds: 14, speakerId: "U0AAAAAAAA1", speaker: "chris", text: "First." },
    { at: "01:15", offsetSeconds: 75.5, speakerId: "U0AAAAAAAA2", speaker: "david", text: "Second." },
    { at: "1:02:05", offsetSeconds: 3725, speakerId: "U0UNKNOWN99", speaker: "U0UNKNOWN99", text: "Late." },
    { at: "1:02:06", offsetSeconds: 3726, speakerId: undefined, speaker: undefined, text: "Nobody." },
  ]);
});

test("transcript text is one [mm:ss] Name: text line per spoken line", () => {
  expect(transcriptText(transcriptLines(transcription, people))).toBe(
    "[00:14] chris: First.\n[01:15] david: Second.\n[1:02:05] U0UNKNOWN99: Late.\n[1:02:06] Nobody."
  );
});

test("transcript speaker ids are listed once each", () => {
  expect(transcriptSpeakerIds(transcription)).toEqual(["U0AAAAAAAA2", "U0AAAAAAAA1", "U0UNKNOWN99"]);
});

test("user mentions in AI notes resolve to names, and unknown ids stay as they are", () => {
  const notes = "@U0AAAAAAAA1 review @U0AAAAAAAA2's work, cc @U0UNKNOWN99 and @here";

  expect(mentionedUserIds(notes)).toEqual(["U0AAAAAAAA1", "U0AAAAAAAA2", "U0UNKNOWN99"]);
  expect(resolveMentions(notes, people)).toBe(
    "@chris review @david's work, cc @U0UNKNOWN99 and @here"
  );
});
