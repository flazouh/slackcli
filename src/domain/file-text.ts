import { Result } from "effect";

import { FileTargetInvalid } from "./errors.ts";

/**
 * Every link Slack hands out for a file carries its id as a path segment:
 * `/files/<user>/<F…>/<name>`, `/docs/<team>/<F…>` for a canvas, and
 * `/files-pri/<team>-<F…>/<name>` for the download URL itself.
 */
const BARE_ID = /^F[A-Z0-9]{6,}$/;
const ID_IN_LINK = /[/-](F[A-Z0-9]{6,})(?=[/?#]|$)/;

export const parseFileTarget = (value: string): Result.Result<string, FileTargetInvalid> => {
  const trimmed = value.trim();
  if (BARE_ID.test(trimmed)) return Result.succeed(trimmed);
  const linked = ID_IN_LINK.exec(trimmed)?.[1];
  return linked === undefined
    ? Result.fail(new FileTargetInvalid({ value }))
    : Result.succeed(linked);
};

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    }
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name.toLowerCase()] ?? whole;
  });

/**
 * A canvas downloads as an HTML document. Block elements become line breaks and
 * list items become bullets; everything else is tag soup a reader does not need.
 */
const htmlText = (html: string): string =>
  decodeEntities(
    html
      .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<(ul|ol)\b[^>]*>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "• ")
      .replace(/<\/(p|h[1-6]|div|section|blockquote|pre|table|ul|ol)>/gi, "\n\n")
      .replace(/<\/(li|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .split("\n")
    .map((entry) => entry.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** `m:ss`, or `h:mm:ss` past the hour, the way Slack labels transcript lines. */
export const clockOffset = (seconds: number): string => {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = String(whole % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
};

const line = (at: number | undefined, speaker: string | undefined, text: string): string =>
  [at === undefined ? undefined : clockOffset(at), speaker === undefined ? text : `${speaker}: ${text}`]
    .filter((part): part is string => part !== undefined)
    .join(" ");

const TIME_KEYS = ["start_time", "start", "startTime", "offset", "time"] as const;
const SPEAKER_KEYS = ["speaker", "speaker_name", "user_name", "name", "user", "user_id"] as const;

type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json };

const isRecord = (value: Json): value is { readonly [key: string]: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const firstNumber = (record: { readonly [key: string]: Json }): number | undefined => {
  for (const key of TIME_KEYS) {
    const value = record[key];
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
};

const firstString = (record: { readonly [key: string]: Json }): string | undefined => {
  for (const key of SPEAKER_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
};

/**
 * Slack does not document the transcript format, so the JSON is read by shape:
 * the first array whose items carry `text` is the list of segments, and each
 * segment's time and speaker are taken from whichever usual key it has.
 */
const segments = (value: Json): ReadonlyArray<string> | undefined => {
  if (Array.isArray(value)) {
    const items = value.filter(isRecord);
    if (items.length > 0 && items.every((item) => typeof item["text"] === "string")) {
      return items.map((item) => line(firstNumber(item), firstString(item), String(item["text"]).trim()));
    }
    for (const item of value) {
      const found = segments(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (isRecord(value)) {
    for (const child of Object.values(value)) {
      const found = segments(child);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

const allTexts = (value: Json): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value.flatMap(allTexts);
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === "text" && typeof child === "string" ? [child] : allTexts(child)
  );
};

const jsonText = (raw: string): string | undefined => {
  let parsed: Json;
  try {
    parsed = JSON.parse(raw) as Json;
  } catch {
    return undefined;
  }
  const found = segments(parsed) ?? allTexts(parsed);
  return found.join("\n").trim();
};

const CUE = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,]\d{3}\s+-->/;

const vttText = (raw: string): string => {
  const lines: Array<string> = [];
  let at: number | undefined;
  for (const entry of raw.split(/\r?\n/)) {
    const cue = CUE.exec(entry);
    if (cue !== null) {
      at = Number(cue[1] ?? 0) * 3600 + Number(cue[2]) * 60 + Number(cue[3]);
      continue;
    }
    if (at === undefined || entry.trim() === "") continue;
    const voice = /^<v\s+([^>]+)>(.*)$/.exec(entry.trim());
    lines.push(
      voice === null
        ? line(at, undefined, entry.trim())
        : line(at, voice[1]?.trim(), (voice[2] ?? "").replace(/<\/v>$/, "").trim())
    );
    at = undefined;
  }
  return lines.join("\n");
};

/**
 * Readable text for a downloaded canvas or transcript. The content type decides
 * first; the body is sniffed when Slack labels it generically.
 */
export const plainText = (raw: string, contentType: string | undefined): string => {
  const type = (contentType ?? "").toLowerCase();
  const body = raw.trimStart();
  if (type.includes("vtt") || body.startsWith("WEBVTT")) return vttText(raw);
  if (type.includes("json") || body.startsWith("{") || body.startsWith("[")) {
    const text = jsonText(raw);
    if (text !== undefined) return text;
  }
  if (type.includes("html") || /^<(!doctype|html|body|div|p|h1)\b/i.test(body)) return htmlText(raw);
  return raw.trim();
};
