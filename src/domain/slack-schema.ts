import { Schema } from "effect";

export interface RichTextStyle {
  readonly code?: boolean;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly strike?: boolean;
}

export interface RichTextObject {
  readonly type?: string;
  readonly text?: RichTextNode;
  readonly elements?: ReadonlyArray<RichTextNode>;
  readonly fields?: ReadonlyArray<RichTextNode>;
  readonly user_id?: string;
  readonly url?: string;
  readonly name?: string;
  readonly range?: string;
  /** An object on a text node; on a list node, Slack sends "bullet" or "ordered". */
  readonly style?: RichTextStyle | string;
}

export type RichTextNode = string | null | ReadonlyArray<RichTextNode> | RichTextObject;

const node = Schema.suspend((): Schema.Codec<RichTextNode> => RichTextNodeSchema);

/**
 * Block Kit is open ended and Slack adds node types continually, so the tree is
 * decoded structurally with typed access to the fields the renderer reads. A
 * strict union of the known block types would fail on a block Slack shipped this
 * morning, and a message that fails to decode is a message the reader cannot see.
 */
const RichTextObjectSchema: Schema.Codec<RichTextObject> = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(node),
  elements: Schema.optionalKey(Schema.Array(node)),
  fields: Schema.optionalKey(Schema.Array(node)),
  user_id: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  range: Schema.optionalKey(Schema.String),
  style: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({
        code: Schema.optionalKey(Schema.Boolean),
        bold: Schema.optionalKey(Schema.Boolean),
        italic: Schema.optionalKey(Schema.Boolean),
        strike: Schema.optionalKey(Schema.Boolean),
      }),
      Schema.String,
    ])
  ),
});

const RichTextNodeSchema: Schema.Codec<RichTextNode> = Schema.Union([
  Schema.String,
  Schema.Null,
  Schema.Array(node),
  RichTextObjectSchema,
]);

export const Attachment = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  fallback: Schema.optionalKey(Schema.String),
});

/**
 * A file shared on a message: an upload, a canvas, a huddle's notes or its
 * transcript. Only `id` is certain; a file Slack hides from this token
 * (`mode: "hidden_by_limit"`, `"tombstone"`) arrives with little else.
 */
export const SlackFile = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  filetype: Schema.optionalKey(Schema.String),
  mimetype: Schema.optionalKey(Schema.String),
  pretty_type: Schema.optionalKey(Schema.String),
  size: Schema.optionalKey(Schema.Number),
  mode: Schema.optionalKey(Schema.String),
  permalink: Schema.optionalKey(Schema.String),
  url_private: Schema.optionalKey(Schema.String),
  url_private_download: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "SlackFile" });
export type SlackFile = typeof SlackFile.Type;

/**
 * What Slack attaches to the message that a huddle posts in its channel. Times
 * are Unix seconds; `participant_history` lists everyone who joined at any point.
 */
export const HuddleRoom = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  date_start: Schema.optionalKey(Schema.Number),
  date_end: Schema.optionalKey(Schema.Number),
  has_ended: Schema.optionalKey(Schema.Boolean),
  participants: Schema.optionalKey(Schema.Array(Schema.String)),
  participant_history: Schema.optionalKey(Schema.Array(Schema.String)),
  attached_file_ids: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type HuddleRoom = typeof HuddleRoom.Type;

/**
 * The fields slackcli reads off any Slack message, whatever endpoint produced
 * it. `ts` is the only field Slack always sends.
 */
export const SlackMessage = Schema.Struct({
  ts: Schema.String,
  text: Schema.optionalKey(Schema.String),
  user: Schema.optionalKey(Schema.String),
  username: Schema.optionalKey(Schema.String),
  bot_id: Schema.optionalKey(Schema.String),
  thread_ts: Schema.optionalKey(Schema.String),
  reply_count: Schema.optionalKey(Schema.Number),
  channel: Schema.optionalKey(Schema.String),
  permalink: Schema.optionalKey(Schema.String),
  blocks: Schema.optionalKey(Schema.Array(RichTextNodeSchema)),
  attachments: Schema.optionalKey(Schema.Array(Attachment)),
  files: Schema.optionalKey(Schema.Array(SlackFile)),
  subtype: Schema.optionalKey(Schema.String),
  room: Schema.optionalKey(HuddleRoom),
}).annotate({ identifier: "SlackMessage" });
export type SlackMessage = typeof SlackMessage.Type;

const Profile = Schema.Struct({
  display_name: Schema.optionalKey(Schema.String),
  real_name: Schema.optionalKey(Schema.String),
});

export const SlackUser = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
  real_name: Schema.optionalKey(Schema.String),
  is_bot: Schema.optionalKey(Schema.Boolean),
  deleted: Schema.optionalKey(Schema.Boolean),
  profile: Schema.optionalKey(Profile),
}).annotate({ identifier: "SlackUser" });
export type SlackUser = typeof SlackUser.Type;

export const SlackChannel = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "SlackChannel" });
export type SlackChannel = typeof SlackChannel.Type;

/**
 * Slack signals failure in the body with HTTP 200, so every response is decoded
 * as this envelope first and only then as its payload.
 */
export const ResponseEnvelope = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "ResponseEnvelope" });

export const HistoryPayload = Schema.Struct({
  messages: Schema.Array(SlackMessage),
  has_more: Schema.optionalKey(Schema.Boolean),
});

/**
 * `conversations.view` returns the channel, its members, its bots and its
 * history in one round trip. It is what Slack's own client calls, and it
 * replaces `conversations.history` plus one `users.info` per author.
 */
export const ConversationViewPayload = Schema.Struct({
  history: Schema.optionalKey(HistoryPayload),
  messages: Schema.optionalKey(Schema.Array(SlackMessage)),
  users: Schema.optionalKey(Schema.Array(SlackUser)),
  bots: Schema.optionalKey(Schema.Array(SlackUser)),
});

export const SearchMatch = Schema.Struct({
  ts: Schema.String,
  text: Schema.optionalKey(Schema.String),
  user: Schema.optionalKey(Schema.String),
  username: Schema.optionalKey(Schema.String),
  permalink: Schema.optionalKey(Schema.String),
  channel: Schema.optionalKey(
    Schema.Struct({
      id: Schema.optionalKey(Schema.String),
      name: Schema.optionalKey(Schema.String),
    })
  ),
  blocks: Schema.optionalKey(Schema.Array(RichTextNodeSchema)),
  attachments: Schema.optionalKey(Schema.Array(Attachment)),
  files: Schema.optionalKey(Schema.Array(SlackFile)),
}).annotate({ identifier: "SearchMatch" });
export type SearchMatch = typeof SearchMatch.Type;

/**
 * Search returns its people as records keyed by id, unlike every other endpoint,
 * which returns arrays. Both are usually empty, because each match already
 * carries its author's `username`.
 */
export const SearchPayload = Schema.Struct({
  messages: Schema.optionalKey(
    Schema.Struct({
      total: Schema.optionalKey(Schema.Number),
      matches: Schema.optionalKey(Schema.Array(SearchMatch)),
      paging: Schema.optionalKey(Schema.Struct({ pages: Schema.optionalKey(Schema.Number) })),
    })
  ),
  users: Schema.optionalKey(Schema.Record(Schema.String, SlackUser)),
  bots: Schema.optionalKey(Schema.Record(Schema.String, SlackUser)),
});

export const ConversationListPayload = Schema.Struct({
  channels: Schema.Array(SlackChannel),
  response_metadata: Schema.optionalKey(
    Schema.Struct({ next_cursor: Schema.optionalKey(Schema.String) })
  ),
});

export const FileInfoPayload = Schema.Struct({
  file: SlackFile,
  /** The text itself, for a snippet or a plain-text file. */
  content: Schema.optionalKey(Schema.String),
});

export const UserInfoPayload = Schema.Struct({ user: SlackUser });

export const UsersListPayload = Schema.Struct({
  members: Schema.Array(SlackUser),
  response_metadata: Schema.optionalKey(
    Schema.Struct({ next_cursor: Schema.optionalKey(Schema.String) })
  ),
});

export const AuthTestPayload = Schema.Struct({
  user_id: Schema.String,
  team_id: Schema.String,
  user: Schema.optionalKey(Schema.String),
  team: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  enterprise_id: Schema.optionalKey(Schema.String),
});

export const PostMessagePayload = Schema.Struct({
  ts: Schema.String,
  channel: Schema.String,
});

/** The message an activity item points at. A mention carries text, a bundle does not. */
const ActivityMessage = Schema.Struct({
  channel: Schema.String,
  ts: Schema.String,
  thread_ts: Schema.optionalKey(Schema.String),
  author_user_id: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
});

/**
 * A thread bundle addresses the thread, not one message: `thread_ts` is the root
 * and `latest_ts` is the reply that caused the notification.
 */
const ThreadBundle = Schema.Struct({
  payload: Schema.Struct({
    thread_entry: Schema.Struct({
      channel_id: Schema.String,
      thread_ts: Schema.String,
      latest_ts: Schema.String,
      unread_msg_count: Schema.optionalKey(Schema.Number),
    }),
  }),
});

const DmBundle = Schema.Struct({
  payload: Schema.Struct({
    dm_entry: Schema.Struct({
      latest_message: ActivityMessage,
    }),
  }),
});

/**
 * Slack's activity feed does not describe its items uniformly: a mention carries
 * a message, a reaction carries a message plus the reaction, and a thread or DM
 * carries a bundle that only names timestamps. Each arm is decoded as it really
 * arrives and normalised afterwards by `activityTargets`.
 */
export const ActivityItem = Schema.Struct({
  is_unread: Schema.optionalKey(Schema.Boolean),
  is_bot: Schema.optionalKey(Schema.Boolean),
  item: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("message_reaction"),
      message: ActivityMessage,
      reaction: Schema.Struct({
        user: Schema.optionalKey(Schema.String),
        name: Schema.optionalKey(Schema.String),
      }),
    }),
    Schema.Struct({
      type: Schema.Literal("thread_v2"),
      bundle_info: ThreadBundle,
    }),
    Schema.Struct({
      type: Schema.Literal("dm"),
      bundle_info: DmBundle,
    }),
    Schema.Struct({
      type: Schema.String,
      message: ActivityMessage,
    }),
    // A type this version does not model yet still has to decode, or one unknown
    // item would fail the whole feed.
    Schema.Struct({ type: Schema.String }),
  ]),
}).annotate({ identifier: "ActivityItem" });
export type ActivityItem = typeof ActivityItem.Type;

export const ActivityFeedPayload = Schema.Struct({
  items: Schema.Array(ActivityItem),
});

export const displayName = (user: SlackUser): string =>
  user.profile?.display_name || user.profile?.real_name || user.real_name || user.name || user.id;
