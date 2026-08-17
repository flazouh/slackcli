import { expect, test } from "bun:test";

import {
  activityPeopleIds,
  activityTargets,
  historyRows,
  mentionRows,
  searchRows,
} from "./rows.ts";

const people = (entries: Record<string, string>) => new Map(Object.entries(entries));

test("renders search matches with resolved mentions and stripped links", () => {
  expect(
    searchRows(
      [
        {
          ts: "1700000000.123456",
          username: "sample-user",
          channel: { id: "C00000001", name: "project-alpha" },
          text: "<@U00000002> read <https://example.com/docs/setup|the setup guide>",
          permalink: "https://workspace.invalid/archives/C00000001/p1700000000123456",
        },
      ],
      { people: people({ U00000002: "Example User" }) }
    )
  ).toEqual([
    {
      channel: "#project-alpha",
      author: "sample-user",
      message: "@Example User read the setup guide",
      at: "2023-11-14T22:13:20.123Z",
      url: "https://workspace.invalid/archives/C00000001/p1700000000123456",
    },
  ]);
});

test("keeps a search match usable when Slack returns no text or channel name", () => {
  expect(searchRows([{ ts: "1700000000.123456", user: "U00000009", channel: { id: "C00000001" } }], { people: new Map() })).toEqual([
    {
      channel: "#unknown",
      author: "U00000009",
      message: "Open in Slack for message text.",
      at: "2023-11-14T22:13:20.123Z",
      url: undefined,
    },
  ]);
});

test("decodes Slack-escaped ampersands and angle brackets after markup is parsed", () => {
  const [row] = searchRows(
    [{ ts: "1700000000.123456", username: "sample-user", channel: { name: "project-alpha" }, text: "a &amp; b &lt;tag&gt;" }],
    { people: new Map() }
  );

  expect(row?.message).toBe("a & b <tag>");
});

test("reads block-kit text when a bot message has no top-level text", () => {
  const [row] = searchRows(
    [
      {
        ts: "1700000000.123456",
        username: "build-bot",
        channel: { name: "project-alpha" },
        text: "",
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  { type: "user", user_id: "U00000001" },
                  { type: "text", text: " is checking the build" },
                ],
              },
            ],
          },
        ],
      },
    ],
    { people: people({ U00000001: "Example User" }) }
  );

  expect(row?.message).toBe("@Example User is checking the build");
});

test("falls back to attachment text when a message carries only an attachment", () => {
  const [row] = searchRows(
    [
      {
        ts: "1700000000.123456",
        username: "change-bot",
        channel: { name: "project-alpha" },
        attachments: [{ title: "Change #42", text: "update the parser" }],
      },
    ],
    { people: new Map() }
  );

  expect(row?.message).toBe("Change #42 — update the parser");
});

test("renders channel history oldest-first with resolved authors and permalinks", () => {
  expect(
    historyRows(
      [
        { ts: "1700000002.000002", user: "U00000001", text: "newer" },
        { ts: "1700000001.000001", user: "U00000002", text: "older <@U00000001>" },
      ],
      {
        people: people({ U00000001: "First User", U00000002: "Second User" }),
        channelId: "C00000001",
        workspace: "T00000001",
      }
    )
  ).toEqual([
    {
      author: "Second User",
      message: "older @First User",
      at: "2023-11-14T22:13:21.000Z",
      url: "https://app.slack.com/client/T00000001/C00000001/p1700000001000001",
      replies: undefined,
    },
    {
      author: "First User",
      message: "newer",
      at: "2023-11-14T22:13:22.000Z",
      url: "https://app.slack.com/client/T00000001/C00000001/p1700000002000002",
      replies: undefined,
    },
  ]);
});

test("labels history authored by a bot without a user id", () => {
  expect(
    historyRows([{ ts: "1700000001.000001", bot_id: "B00000001", username: "build-bot", text: "hi" }], {
      people: new Map(),
      channelId: "C00000001",
      workspace: "T00000001",
    })
  ).toEqual([
    {
      author: "build-bot",
      message: "hi",
      at: "2023-11-14T22:13:21.000Z",
      url: "https://app.slack.com/client/T00000001/C00000001/p1700000001000001",
      replies: undefined,
    },
  ]);
});

test("renders activity items with human labels, channel names and cleaned text", () => {
  expect(
    mentionRows(
      activityTargets([
        {
          is_unread: true,
          item: {
            type: "at_channel",
            message: {
              channel: "C00000001",
              ts: "1700000011.000001",
              author_user_id: "U00000001",
              text: "<!channel> Welcome <@U00000002> <https://example.com|here>",
            },
          },
        },
        {
          is_unread: false,
          is_bot: true,
          item: { type: "at_user", message: { channel: "C00000001", ts: "1700000010.000000", author_user_id: "B00000001" } },
        },
      ]),
      {
        people: people({ U00000001: "First User", U00000002: "Second User" }),
        channels: new Map([["C00000001", "general"]]),
        workspace: "T00000001",
      }
    )
  ).toEqual([
    {
      notification: "@channel mention",
      unread: true,
      channel: "#general",
      author: "First User",
      message: "@channel Welcome @Second User here",
      at: "2023-11-14T22:13:31.000Z",
      url: "https://app.slack.com/client/T00000001/C00000001/p1700000011000001",
    },
    {
      notification: "Direct mention",
      unread: false,
      channel: "#general",
      author: "Slack bot",
      message: "Open in Slack for message text.",
      at: "2023-11-14T22:13:30.000Z",
      url: "https://app.slack.com/client/T00000001/C00000001/p1700000010000000",
    },
  ]);
});

test("a thread bundle points at the reply that caused the notification", () => {
  const [target] = activityTargets([
    {
      is_unread: true,
      item: {
        type: "thread_v2",
        bundle_info: {
          payload: {
            thread_entry: {
              channel_id: "C00000001",
              thread_ts: "1700000100.000000",
              latest_ts: "1700000101.000000",
              unread_msg_count: 4,
            },
          },
        },
      },
    },
  ]);

  expect(target).toMatchObject({
    channel: "C00000001",
    ts: "1700000101.000000",
    threadTs: "1700000100.000000",
    unreadCount: 4,
  });

  // A bundle carries no text, so the service fetches it and fills the target in.
  const [row] = mentionRows(target === undefined ? [] : [{ ...target, text: "checks passed" }], {
    people: new Map(),
    channels: new Map([["C00000001", "project-alpha"]]),
    workspace: "T00000001",
  });

  expect(row?.notification).toBe("Thread reply (4 unread)");
  expect(row?.message).toBe("checks passed");
});

test("a reaction names whoever reacted, with the emoji", () => {
  const targets = activityTargets([
    {
      is_unread: true,
      item: {
        type: "message_reaction",
        message: { channel: "C00000002", ts: "1700000200.000000" },
        reaction: { user: "U00000007", name: "white_check_mark" },
      },
    },
  ]).map((target) => ({ ...target, text: "deployment complete" }));

  // The reactor is the person to name, so the reader knows who reacted rather
  // than reading their own name back.
  expect(targets.flatMap(activityPeopleIds)).toEqual(["U00000007"]);

  const [row] = mentionRows(targets, {
    people: people({ U00000007: "Reaction Author" }),
    channels: new Map([["C00000002", "team-updates"]]),
    workspace: "T00000001",
  });

  expect(row).toMatchObject({
    notification: "Reacted :white_check_mark:",
    author: "Reaction Author",
    message: "deployment complete",
  });
});

test("a direct message bundle keeps the text it already carries", () => {
  const [row] = mentionRows(
    activityTargets([
      {
        item: {
          type: "dm",
          bundle_info: {
            payload: {
              dm_entry: {
                latest_message: {
                  channel: "D00000001",
                  ts: "1700000300.000000",
                  author_user_id: "U00000003",
                  text: "can you review this?",
                },
              },
            },
          },
        },
      },
    ]),
    {
      people: people({ U00000003: "Example User" }),
      channels: new Map(),
      workspace: "T00000001",
    }
  );

  expect(row).toMatchObject({
    notification: "Direct message",
    channel: "DM",
    author: "Example User",
    message: "can you review this?",
  });
});

test("an activity type this version does not model is skipped", () => {
  expect(activityTargets([{ item: { type: "channel" } }])).toEqual([]);
});
