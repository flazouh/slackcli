import type { PeopleIndex } from "./message-text.ts";
import type { HuddleTranscription } from "./slack-schema.ts";

export interface TranscriptLine {
  /** The offset from the start of the huddle, as `mm:ss` or `h:mm:ss`. */
  readonly at: string;
  readonly offsetSeconds: number;
  readonly speakerId: string | undefined;
  /** The speaker's display name, or their id when it could not be resolved. */
  readonly speaker: string | undefined;
  readonly text: string;
}

const pad = (value: number): string => String(value).padStart(2, "0");

export const transcriptClock = (seconds: number): string => {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = `${pad(minutes)}:${pad(whole % 60)}`;
  return hours > 0 ? `${hours}:${rest}` : rest;
};

export const transcriptSpeakerIds = (transcription: HuddleTranscription): ReadonlyArray<string> => [
  ...new Set(
    transcription.lines.flatMap((line) => (line.user_id === undefined ? [] : [line.user_id]))
  ),
];

export const transcriptLines = (
  transcription: HuddleTranscription,
  people: PeopleIndex
): ReadonlyArray<TranscriptLine> =>
  [...transcription.lines]
    .sort((left, right) => left.start_time_ms - right.start_time_ms)
    .map((line) => ({ line, text: line.contents.trim() }))
    .filter(({ text }) => text !== "")
    .map(({ line, text }) => ({
      at: transcriptClock(line.start_time_ms / 1000),
      offsetSeconds: line.start_time_ms / 1000,
      speakerId: line.user_id,
      speaker: line.user_id === undefined ? undefined : (people.get(line.user_id) ?? line.user_id),
      text,
    }));

export const transcriptText = (lines: ReadonlyArray<TranscriptLine>): string =>
  lines
    .map((line) =>
      line.speaker === undefined ? `[${line.at}] ${line.text}` : `[${line.at}] ${line.speaker}: ${line.text}`
    )
    .join("\n");

/** A canvas mentions people as `@U0123ABCD`; enterprise users carry a `W` prefix. */
const MENTION = /@([UW][A-Z0-9]{8,})\b/g;

export const mentionedUserIds = (text: string): ReadonlyArray<string> => [
  ...new Set([...text.matchAll(MENTION)].map((match) => match[1] ?? "")),
];

export const resolveMentions = (text: string, people: PeopleIndex): string =>
  text.replace(MENTION, (whole, id: string) => {
    const name = people.get(id);
    return name === undefined || name === id ? whole : `@${name}`;
  });
