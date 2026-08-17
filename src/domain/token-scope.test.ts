import { expect, test } from "bun:test";

import { isExpiredCredential, isWrongTokenError, preferredScope } from "./token-scope.ts";

test("org-wide reads ask for the org token first", () => {
  expect(preferredScope("search.messages")).toBe("org");
  expect(preferredScope("activity.feed")).toBe("org");
  expect(preferredScope("conversations.view")).toBe("org");
});

test("everything else asks for the workspace token first", () => {
  expect(preferredScope("conversations.history")).toBe("workspace");
  expect(preferredScope("users.conversations")).toBe("workspace");
  expect(preferredScope("chat.postMessage")).toBe("workspace");
});

test("team_is_restricted means wrong token, not wrong credentials", () => {
  // A workspace token returns this for org-scoped methods on Enterprise Grid.
  // Treating it as fatal is what silently broke mentions.
  expect(isWrongTokenError("team_is_restricted")).toBe(true);
  expect(isExpiredCredential("team_is_restricted")).toBe(false);
});

test("expired credentials are not retried with the other token", () => {
  expect(isExpiredCredential("invalid_auth")).toBe(true);
  expect(isExpiredCredential("token_revoked")).toBe(true);
  expect(isWrongTokenError("invalid_auth")).toBe(false);
});

test("an ordinary refusal is neither a token swap nor a re-login", () => {
  expect(isWrongTokenError("channel_not_found")).toBe(false);
  expect(isExpiredCredential("channel_not_found")).toBe(false);
});
