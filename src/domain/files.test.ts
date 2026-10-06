import { expect, test } from "bun:test";

import { fileRows } from "./files.ts";
import { historyRows, mentionRows, searchRows } from "./rows.ts";

const context = { people: new Map<string, string>(), channelId: "C00000001", workspace: "T00000001" };

const screenshot = {
  id: "F00000001",
  name: "screenshot.png",
  title: "Screenshot 2026-10-06",
  filetype: "png",
  mimetype: "image/png",
  pretty_type: "PNG",
  size: 421_888,
  permalink: "https://workspace.slack.com/files/U00000001/F00000001/screenshot.png",
};

test("a file-only message names the file instead of sending the reader to Slack", () => {
  const [row] = historyRows([{ ts: "1700000001.000001", user: "U1", text: "", files: [screenshot] }], context);

  expect(row?.message).toBe("[file] screenshot.png (image/png, 412 KB)");
});

test("every message row carries its files with id, type, size and permalink", () => {
  const [row] = historyRows([{ ts: "1700000001.000001", user: "U1", text: "look", files: [screenshot] }], context);

  expect(row?.files).toEqual([
    {
      id: "F00000001",
      kind: "file",
      name: "screenshot.png",
      title: "Screenshot 2026-10-06",
      filetype: "png",
      mimetype: "image/png",
      size: 421_888,
      permalink: "https://workspace.slack.com/files/U00000001/F00000001/screenshot.png",
    },
  ]);
});

test("a message with text and a file keeps the text and lists the file under it", () => {
  const [row] = historyRows([{ ts: "1700000001.000001", user: "U1", text: "see this", files: [screenshot] }], context);

  expect(row?.message).toBe("see this\n[file] screenshot.png (image/png, 412 KB)");
});

test("a message without files has an empty files list", () => {
  const [row] = historyRows([{ ts: "1700000001.000001", user: "U1", text: "hi" }], context);

  expect(row?.files).toEqual([]);
});

test("a canvas and a huddle transcript show as files with their own kind", () => {
  const rows = fileRows([
    {
      id: "F0C77BN7ZJ5",
      name: "Huddle notes: 10/6/26 in #proj-ori",
      title: "Huddle notes: 10/6/26 in #proj-ori",
      filetype: "quip",
      pretty_type: "Canvas",
    },
    {
      id: "F0C73ERJ2LW",
      title: "Huddle transcript",
      filetype: "huddle_transcript",
      permalink: "https://workspace.slack.com/files/U00000001/F0C73ERJ2LW/huddle_transcript",
    },
  ]);

  expect(rows.map((file) => file.kind)).toEqual(["canvas", "transcript"]);
});

test("search rows and mention rows carry files too", () => {
  const [match] = searchRows([{ ts: "1700000000.123456", username: "a", files: [screenshot] }], {
    people: new Map(),
  });
  const [mention] = mentionRows(
    [
      {
        kind: "dm",
        channel: "D00000001",
        ts: "1700000000.123456",
        threadTs: undefined,
        authorId: "U1",
        text: "",
        files: [screenshot],
        reactorId: undefined,
        reactionName: undefined,
        unreadCount: undefined,
        unread: false,
        bot: false,
      },
    ],
    { people: new Map(), channels: new Map(), workspace: "T1" }
  );

  expect(match?.files.map((file) => file.id)).toEqual(["F00000001"]);
  expect(mention?.message).toBe("[file] screenshot.png (image/png, 412 KB)");
  expect(mention?.files.map((file) => file.id)).toEqual(["F00000001"]);
});

test("a file Slack hides from this token still gets a line", () => {
  const [row] = historyRows(
    [{ ts: "1700000001.000001", user: "U1", files: [{ id: "F00000009", mode: "hidden_by_limit" }] }],
    context
  );

  expect(row?.message).toBe("[file] F00000009 (hidden by Slack)");
});

test("a file titled as a transcript counts as a transcript whatever its filetype", () => {
  expect(fileRows([{ id: "F1", title: "Huddle transcript", filetype: "text" }])[0]?.kind).toBe(
    "transcript"
  );
});
