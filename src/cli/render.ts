import type { MentionRow, MessageRow, SearchRow } from "../domain/rows.ts";
import type { HuddleView } from "../services/slack.ts";

export interface Paint {
  readonly dim: (value: string) => string;
  readonly bold: (value: string) => string;
  readonly accent: (value: string) => string;
}

const plain: Paint = { dim: (v) => v, bold: (v) => v, accent: (v) => v };

const colored: Paint = {
  dim: (value) => `\u001B[2m${value}\u001B[22m`,
  bold: (value) => `\u001B[1m${value}\u001B[22m`,
  accent: (value) => `\u001B[36m${value}\u001B[39m`,
};

export const paintFor = (color: boolean): Paint => (color ? colored : plain);

const AUTHOR_WIDTH = 18;

/**
 * A timestamp is only worth its width if it says something. Inside today, the
 * clock time is enough; older rows need the date, so they get it.
 */
const clock = (iso: string, now: Date): string => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "??:??";

  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();

  if (sameDay) return time;
  return `${at.toLocaleDateString([], { month: "short", day: "2-digit" })} ${time}`;
};

const pad = (value: string, width: number): string =>
  value.length >= width ? value.slice(0, width) : value + " ".repeat(width - value.length);

/**
 * Wrapping is left to the terminal, but continuation lines are indented to the
 * message column so a multi-line message still reads as one message.
 */
const indent = (message: string, gutter: number): string =>
  message.split("\n").join(`\n${" ".repeat(gutter)}`);

const KEPT_LINES = 4;
const KEPT_CHARS = 480;

/**
 * A single status post from a bot can be forty lines long, and one message
 * scrolling the rest of the channel off screen defeats the point of reading
 * Slack in a terminal. The cut is always announced, and `--full` prints
 * everything.
 */
const clamp = (message: string, paint: Paint): string => {
  const lines = message.split("\n");
  const hidden = lines.length - KEPT_LINES;
  const kept = lines.slice(0, KEPT_LINES).join("\n");
  const overlong = kept.length > KEPT_CHARS;
  if (hidden <= 0 && !overlong) return message;

  // The line count is the more useful of the two, and only one marker is printed,
  // so a message cut on both counts does not end in two ellipses.
  const short = overlong ? kept.slice(0, KEPT_CHARS).trimEnd() : kept;
  const marker = hidden > 0 ? `… +${hidden} ${hidden === 1 ? "line" : "lines"}` : "…";
  return `${short} ${paint.dim(marker)}`;
};

/** A run of empty lines is one paragraph break to a reader, whatever Slack sent. */
const tidy = (message: string): string => message.replace(/\n{3,}/g, "\n\n").trim();

const body = (message: string, options: { readonly paint: Paint; readonly full: boolean }): string => {
  const tidied = tidy(message);
  return options.full ? tidied : clamp(tidied, options.paint);
};

interface Columns {
  readonly time: number;
  readonly author: number;
}

/** One visible character plus its separator, whatever escape codes paint added. */
const MARK_WIDTH = 2;

/**
 * `mark` is a fixed-width lane before the timestamp, so a wrapped message lines
 * up with the first line of its own text and not two columns to the left of it.
 * It must be a single visible character, since its width is assumed, not counted.
 */
const line = (
  paint: Paint,
  row: {
    readonly mark?: string;
    readonly time: string;
    readonly author: string;
    readonly message: string;
  },
  columns: Columns
): string => {
  const mark = row.mark === undefined ? "" : `${row.mark} `;
  const lane = row.mark === undefined ? 0 : MARK_WIDTH;
  const gutter = lane + columns.time + 2 + columns.author + 2;
  const time = paint.dim(pad(row.time, columns.time));
  return `${mark}${time}  ${paint.bold(pad(row.author, columns.author))}  ${indent(row.message, gutter)}`;
};

/**
 * Column widths are measured across the whole batch, not per row. A row dated
 * today has a shorter timestamp than one dated last week, so measuring per row
 * would indent each wrapped message to a different column.
 */
const columnsFor = (
  rows: ReadonlyArray<{ readonly author: string; readonly at: string }>,
  now: Date
): Columns => ({
  time: Math.max(...rows.map((row) => clock(row.at, now).length)),
  author: Math.min(AUTHOR_WIDTH, Math.max(6, ...rows.map((row) => row.author.length))),
});

export interface RenderOptions {
  readonly paint: Paint;
  readonly now: Date;
  readonly full: boolean;
}

export const renderMessages = (
  header: string,
  rows: ReadonlyArray<MessageRow>,
  options: RenderOptions
): string => {
  if (rows.length === 0) return options.paint.dim(`${header}: no messages`);

  const columns = columnsFor(rows, options.now);
  const lines = rows.map((row) => {
    const thread =
      row.replies === undefined || row.replies === 0
        ? ""
        : ` ${options.paint.dim(`↳ ${row.replies} ${row.replies === 1 ? "reply" : "replies"}`)}`;

    return line(
      options.paint,
      {
        time: clock(row.at, options.now),
        author: row.author,
        message: `${body(row.message, options)}${thread}`,
      },
      columns
    );
  });

  return [options.paint.accent(header), ...lines].join("\n");
};

export const renderSearch = (
  rows: ReadonlyArray<SearchRow>,
  options: RenderOptions & { readonly total: number | undefined }
): string => {
  if (rows.length === 0) return options.paint.dim("No matches");

  const columns = columnsFor(rows, options.now);
  const header = options.total === undefined ? "matches" : `${options.total} matches`;

  const found = rows.flatMap((row) => {
    const first = line(
      options.paint,
      { time: clock(row.at, options.now), author: row.author, message: body(row.message, options) },
      columns
    );
    const where = options.paint.dim(`   ${row.channel}`);
    return [first, row.url === undefined ? where : options.paint.dim(`${where}  ${row.url}`)];
  });

  return [options.paint.dim(header), ...found].join("\n");
};

export const renderMentions = (
  rows: ReadonlyArray<MentionRow>,
  options: RenderOptions
): string => {
  if (rows.length === 0) return options.paint.dim("Nothing waiting for you");

  const columns = columnsFor(rows, options.now);

  return rows
    .flatMap((row) => {
      const label = options.paint.dim(`${row.notification} in ${row.channel}`);
      const first = line(
        options.paint,
        {
          mark: row.unread ? options.paint.accent("●") : " ",
          time: clock(row.at, options.now),
          author: row.author,
          message: body(row.message, options),
        },
        columns
      );
      return [first, options.paint.dim(`   ${label}  ${row.url}`)];
    })
    .join("\n");
};

const duration = (seconds: number): string => {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};

/**
 * Notes and transcript are printed whole: a huddle is read to learn what was
 * said, and a clamped transcript hides exactly that.
 */
export const renderHuddle = (view: HuddleView, options: RenderOptions): string => {
  const { paint } = options;
  const header = paint.accent(`Huddle in ${view.channel}`);
  if (!view.isHuddle) return `${paint.dim(`${view.channel}: this thread is not a huddle`)}\n${view.url}`;

  const facts = [
    `${header}  ${paint.dim(view.url)}`,
    `Attended: ${view.attendees.length === 0 ? "unknown" : view.attendees.join(", ")}`,
    ...(view.startedAt === undefined ? [] : [`Started: ${view.startedAt}`]),
    view.durationSeconds === undefined
      ? `Duration: ${view.ended ? "unknown" : "still running"}`
      : `Duration: ${duration(view.durationSeconds)}`,
  ];

  const section = (label: string, part: HuddleView["notes"], missingKey: string): string => {
    if (part !== undefined) return `${paint.bold(`${label} (${part.file.id})`)}\n${part.text}`;
    const reason = view.missing.find((entry) => entry.startsWith(missingKey));
    const detail = reason === undefined || reason === missingKey ? "none in this thread" : reason;
    return paint.bold(`${label}: ${detail}`);
  };

  return [
    facts.join("\n"),
    section("AI notes", view.notes, "AI notes"),
    section("Transcript", view.transcript, "transcript"),
  ].join("\n\n");
};
