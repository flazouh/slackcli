import { Effect } from "effect";

import { SlackAuthExpired, SlackResponseInvalid } from "../domain/errors.ts";
import { fileRow, isHuddleTranscript } from "../domain/files.ts";
import type { FileRow } from "../domain/files.ts";
import { plainText } from "../domain/file-text.ts";
import { FileInfoPayload } from "../domain/slack-schema.ts";
import type { SlackFile } from "../domain/slack-schema.ts";
import {
  mentionedUserIds,
  resolveMentions,
  transcriptLines,
  transcriptSpeakerIds,
  transcriptText,
} from "../domain/transcript.ts";
import type { TranscriptLine } from "../domain/transcript.ts";
import { slackCall } from "./slack-api.ts";
import type { SlackApi } from "./slack-api.ts";
import type { UserDirectory } from "./user-directory.ts";

export interface FetchedFile {
  readonly file: FileRow;
  readonly bytes: Uint8Array;
  readonly contentType: string | undefined;
}

export interface FileTextView {
  readonly file: FileRow;
  readonly text: string;
}

/** A huddle transcript: `text` holds one `[mm:ss] Name: text` line per entry in `lines`. */
export interface TranscriptView extends FileTextView {
  readonly lines: ReadonlyArray<TranscriptLine>;
}

/**
 * Reads one Slack file: its metadata, its bytes, or its text. A canvas is
 * downloaded and converted; a huddle transcript is read from `files.info`.
 */
export const fileReader = (api: SlackApi["Service"], users: UserDirectory["Service"]) => {
  // `include_transcription` is what the web client sends to read a huddle
  // transcript; other files ignore it.
  const fileInfo = (id: string) =>
    api
      .call(slackCall("files.info", { file: id, include_transcription: true }, FileInfoPayload))
      .pipe(Effect.map((payload) => payload.file));

  /**
   * A transcript's download URL redirects to the web app, so its text comes
   * only from the `huddle_transcription` lines that `files.info` returns.
   */
  const transcriptOf = Effect.fn("Slack.transcriptOf")(function* (file: SlackFile) {
    const transcription = file.huddle_transcription;
    if (transcription === undefined) {
      return yield* new SlackResponseInvalid({
        method: "files.info",
        detail: `file ${file.id} came back without its transcript lines`,
      });
    }
    const people = yield* users.names(transcriptSpeakerIds(transcription));
    const lines = transcriptLines(transcription, people);
    return { file: fileRow(file), text: transcriptText(lines), lines } satisfies TranscriptView;
  });

  const downloadFile = Effect.fn("Slack.downloadFile")(function* (file: SlackFile) {
    const row = fileRow(file);
    const url = file.url_private_download ?? file.url_private;
    if (url === undefined) {
      return yield* new SlackResponseInvalid({
        method: "files.info",
        detail: `file ${file.id} has no download URL (mode: ${file.mode ?? "unknown"})`,
      });
    }

    const downloaded = yield* api.download(url);
    // Slack answers an unauthorised file request with its sign-in page, as
    // a 200. Only a canvas is expected to be HTML.
    const html = downloaded.contentType?.toLowerCase().includes("text/html") === true;
    if (html && row.kind === "file" && row.mimetype?.includes("html") !== true) {
      return yield* new SlackAuthExpired({
        slackError: "the file download returned a sign-in page",
      });
    }

    return {
      file: row,
      bytes: downloaded.bytes,
      contentType: downloaded.contentType,
    } satisfies FetchedFile;
  });

  const fetchFile = Effect.fn("Slack.fetchFile")(function* (id: string) {
    const file = yield* fileInfo(id);
    if (!isHuddleTranscript(file)) return yield* downloadFile(file);
    const transcript = yield* transcriptOf(file);
    return {
      file: transcript.file,
      bytes: new TextEncoder().encode(`${transcript.text}\n`),
      contentType: "text/plain; charset=utf-8",
    } satisfies FetchedFile;
  });

  const textOf = Effect.fn("Slack.textOf")(function* (file: SlackFile) {
    if (isHuddleTranscript(file)) return yield* transcriptOf(file);
    const fetched = yield* downloadFile(file);
    const text = plainText(new TextDecoder().decode(fetched.bytes), fetched.contentType);
    const people = yield* users.names(mentionedUserIds(text));
    return { file: fetched.file, text: resolveMentions(text, people) } satisfies FileTextView;
  });

  const fileText = (id: string) => fileInfo(id).pipe(Effect.flatMap(textOf));

  return { fileInfo, fetchFile, fileText, textOf, transcriptOf };
};
