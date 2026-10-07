import type { SlackFile } from "./slack-schema.ts";

/**
 * What a file is to a reader. A canvas and a huddle transcript are files to
 * Slack's API, but they hold text worth reading, and `slackcli file --text`
 * converts exactly those two.
 */
export type FileKind = "file" | "canvas" | "transcript";

export interface FileRow {
  readonly id: string;
  readonly kind: FileKind;
  readonly name: string | undefined;
  readonly title: string | undefined;
  readonly filetype: string | undefined;
  readonly mimetype: string | undefined;
  readonly size: number | undefined;
  readonly permalink: string | undefined;
}

export const fileKind = (file: SlackFile): FileKind => {
  if (
    file.filetype === "huddle_transcript" ||
    file.permalink?.endsWith("/huddle_transcript") === true ||
    /\btranscript\b/i.test(file.title ?? file.name ?? "")
  ) {
    return "transcript";
  }
  if (file.filetype === "quip" || file.filetype === "canvas" || file.pretty_type === "Canvas") {
    return "canvas";
  }
  return "file";
};

/**
 * A transcript a huddle produced, as opposed to any file whose title says
 * "transcript". Only these carry their text in `files.info`.
 */
export const isHuddleTranscript = (file: SlackFile): boolean =>
  file.filetype === "huddle_transcript" || file.huddle_transcription !== undefined;

export const fileRow = (file: SlackFile): FileRow => ({
  id: file.id,
  kind: fileKind(file),
  name: file.name,
  title: file.title,
  filetype: file.filetype,
  mimetype: file.mimetype,
  size: file.size,
  permalink: file.permalink,
});

export const fileRows = (files: ReadonlyArray<SlackFile> | undefined): ReadonlyArray<FileRow> =>
  (files ?? []).map(fileRow);

const UNITS = ["B", "KB", "MB", "GB"] as const;

/** Binary units, rounded, the way a file manager shows them. */
export const humanSize = (bytes: number): string => {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${shown} ${UNITS[unit]}`;
};

const HIDDEN_MODES: ReadonlySet<string> = new Set(["hidden_by_limit", "tombstone"]);

/**
 * One line per file, so a screenshot reads as `[file] shot.png (image/png, 412 KB)`
 * instead of a message with no text. A file Slack withholds still gets its line:
 * a message that silently looks empty is the failure this replaces.
 */
export const fileLine = (file: SlackFile): string => {
  const label = file.name || file.title || file.id;
  if (file.mode !== undefined && HIDDEN_MODES.has(file.mode)) {
    return `[${fileKind(file)}] ${label} (hidden by Slack)`;
  }
  const details = [
    file.mimetype || file.pretty_type || file.filetype,
    file.size === undefined ? undefined : humanSize(file.size),
  ].filter((part): part is string => part !== undefined && part !== "");
  return details.length === 0
    ? `[${fileKind(file)}] ${label}`
    : `[${fileKind(file)}] ${label} (${details.join(", ")})`;
};
