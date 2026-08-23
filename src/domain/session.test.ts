import { expect, test } from "bun:test";

import { Redacted } from "effect";

import { cookieHeader } from "./session.ts";

const session = (cookie: string) =>
  ({
    kind: "session",
    workspaceToken: Redacted.make("xoxc-workspace"),
    cookie: Redacted.make(cookie),
  }) as const;

// The login prompt asks for "the d=… value", so most stored credentials are the
// bare xoxd- string. A cookie header without the `d=` name is rejected by Slack
// as invalid_auth even when the credential itself is valid.
test("a bare cookie value is sent under the d= name", () => {
  expect(cookieHeader(session("xoxd-abc%2Fdef"))).toBe("d=xoxd-abc%2Fdef");
});

test("an already-prefixed cookie passes through unchanged", () => {
  expect(cookieHeader(session("d=xoxd-abc%2Fdef"))).toBe("d=xoxd-abc%2Fdef");
});

test("an OAuth credential sends no cookie", () => {
  expect(
    cookieHeader({ kind: "bearer", token: Redacted.make("xoxp-abc") })
  ).toBeUndefined();
});
