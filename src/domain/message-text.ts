import { fileLine } from "./files.ts";
import type {
  Attachment,
  RichTextNode,
  RichTextObject,
  RichTextStyle,
  SlackFile,
} from "./slack-schema.ts";

export type PeopleIndex = ReadonlyMap<string, string>;

/**
 * Slack puts message content in three different places depending on who posted
 * it. Anything carrying those three fields can be rendered, which is why this
 * is structural: a search match and a channel message share no other shape.
 */
export interface TextBearing {
  readonly text?: string | undefined;
  readonly blocks?: ReadonlyArray<RichTextNode> | undefined;
  readonly attachments?: ReadonlyArray<typeof Attachment.Type> | undefined;
  readonly files?: ReadonlyArray<SlackFile> | undefined;
}

export const NO_TEXT = "Open in Slack for message text.";

const MENTION = /<@([A-Z0-9]+)>/g;

/** The people a message talks to, whose names need resolving as much as its author's. */
export const mentionedIds = (message: TextBearing): ReadonlyArray<string> => {
  const text = messageText(message);
  return text === "" ? [] : [...text.matchAll(MENTION)].flatMap((match) => match[1] ?? []);
};

/**
 * Slack's own mrkdwn, turned into something a terminal reader can scan:
 * `<@U123>` becomes a display name, `<url|label>` keeps only the label.
 */
export const readableSlackText = (text: string, people: PeopleIndex): string =>
  text
    .replace(/<!(channel|here|everyone)>/g, "@$1")
    .replace(MENTION, (whole, userId: string) => {
      const known = people.get(userId);
      // An unresolved id is left as Slack wrote it. Inventing a word for a
      // person the lookup missed reads as if the message named nobody.
      return known === undefined ? whole : `@${known}`;
    })
    .replace(/<[^>|]+\|([^>]+)>/g, "$1")
    .replace(/<([^>]+)>/g, "$1")
    // Slack escapes user-typed angle brackets and ampersands, so decode them
    // only after the markup above has been parsed.
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

// `Array.isArray` widens to `any[]`, which does not remove the readonly array
// member from the node union. A predicate keeps the negative branch narrowed.
const isNodeList = (node: RichTextNode): node is ReadonlyArray<RichTextNode> =>
  Array.isArray(node);

/**
 * Containers whose children are words in one sentence. Every other container
 * holds separate blocks, and joining those inline is what turns a long post into
 * one unreadable line.
 */
const INLINE_CONTAINERS: ReadonlySet<string> = new Set([
  "rich_text_section",
  "rich_text_preformatted",
  "rich_text_quote",
]);

/** Slack marks styling on the node, so the mrkdwn it stands for is re-applied here. */
const styled = (text: string, style: RichTextStyle | string | undefined): string => {
  if (text === "" || style === undefined || typeof style === "string") return text;
  if (style.code === true) return `\`${text}\``;
  if (style.bold === true) return `*${text}*`;
  if (style.italic === true) return `_${text}_`;
  if (style.strike === true) return `~${text}~`;
  return text;
};

const prefixLines = (value: string, prefix: string): string =>
  value
    .split("\n")
    .map((entry) => `${prefix}${entry}`)
    .join("\n");

const numberLines = (value: string): string =>
  value
    .split("\n")
    .map((entry, index) => `${index + 1}. ${entry}`)
    .join("\n");

const blockText = (node: RichTextNode, separator: string): string => {
  if (typeof node === "string") return node;
  if (node === null) return "";
  if (isNodeList(node)) {
    return node
      .map((child) => blockText(child, separator))
      .filter((part) => part !== "")
      .join(separator);
  }
  return objectText(node);
};

/**
 * Whitespace is never trimmed inside a node: Slack carries the space between
 * `@example-user` and the next word as its own text element. Trimming each
 * element runs the words together. Mentions and emoji are re-emitted as the
 * markup they stand for, which `readableSlackText` then resolves.
 */
const objectText = (node: RichTextObject): string => {
  if (node.type === "user" && node.user_id !== undefined) return `<@${node.user_id}>`;
  if (node.type === "emoji" && node.name !== undefined) return `:${node.name}:`;
  if (node.type === "broadcast" && node.range !== undefined) return `@${node.range}`;
  if (node.type === "text") return styled(blockText(node.text ?? null, ""), node.style);
  if (node.type === "link") {
    const label = blockText(node.text ?? null, "");
    return label === "" ? node.url ?? "" : label;
  }

  const inner = node.type !== undefined && INLINE_CONTAINERS.has(node.type) ? "" : "\n";
  const parts = [
    blockText(node.text ?? null, inner),
    blockText(node.elements ?? null, inner),
    blockText(node.fields ?? null, inner),
  ].filter((part) => part !== "");

  const joined = parts.join(inner);
  if (node.type === "rich_text_list") {
    return node.style === "ordered" ? numberLines(joined) : prefixLines(joined, "• ");
  }
  if (node.type === "rich_text_quote") return prefixLines(joined, "> ");
  if (node.type === "rich_text_preformatted") return `\`\`\`\n${joined}\n\`\`\``;
  return joined;
};

const attachmentText = (attachments: ReadonlyArray<typeof Attachment.Type>): string =>
  attachments
    .map((attachment) =>
      [attachment.title, attachment.text ?? attachment.fallback].filter(Boolean).join(" — ")
    )
    .filter(Boolean)
    .join("\n");

/**
 * Blocks first, because Slack's `text` is only a flat fallback: for a long post
 * it arrives with every paragraph break replaced by a space, while the blocks
 * still carry the structure. Text and attachments cover the messages that have
 * no blocks, or blocks holding nothing readable such as a lone image.
 */
export const messageText = (message: TextBearing): string =>
  (blockText(message.blocks ?? null, "\n").trim() ||
    message.text ||
    attachmentText(message.attachments ?? [])).trim();

/**
 * The text, then one line per file. `NO_TEXT` is left only for a message that
 * has neither, because a file-only message (a screenshot, a huddle's notes) is
 * readable once its files are named.
 */
export const readableMessage = (message: TextBearing, people: PeopleIndex): string => {
  const text = messageText(message);
  const lines = [
    ...(text ? [readableSlackText(text, people)] : []),
    ...(message.files ?? []).map(fileLine),
  ];
  return lines.length === 0 ? NO_TEXT : lines.join("\n");
};

export const slackTsToIso = (ts: string): string => new Date(Number(ts) * 1000).toISOString();
