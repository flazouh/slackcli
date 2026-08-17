/**
 * Enterprise Grid hands the web client two tokens with different reach: an org
 * token (`E…`) and a workspace token (`T…`). Which one a method needs is not
 * documented anywhere, so it is encoded here as data and covered by tests.
 */
export type TokenScope = "org" | "workspace";

/**
 * Methods that answer for the whole org and can reject a workspace token with
 * `team_is_restricted`.
 */
const ORG_FIRST: ReadonlySet<string> = new Set([
  "search.messages",
  "search.files",
  "activity.feed",
  "conversations.view",
]);

export const preferredScope = (method: string): TokenScope =>
  ORG_FIRST.has(method) ? "org" : "workspace";

/**
 * Slack errors that mean "right credentials, wrong token for this method". The
 * caller should retry with the other token rather than fail.
 *
 * `team_is_restricted` is the one a workspace token returns for an org-scoped
 * method. Leaving it out silently breaks `activity.feed` and
 * `conversations.view` on Enterprise Grid.
 */
const WRONG_TOKEN_ERRORS: ReadonlySet<string> = new Set([
  "team_is_restricted",
  "enterprise_is_restricted",
  "not_allowed_token_type",
  "missing_scope",
]);

export const isWrongTokenError = (slackError: string): boolean =>
  WRONG_TOKEN_ERRORS.has(slackError);

/**
 * Errors that mean the credential itself is finished. Retrying with the other
 * token cannot help, and the user has to sign in again.
 */
const EXPIRED_ERRORS: ReadonlySet<string> = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
]);

export const isExpiredCredential = (slackError: string): boolean =>
  EXPIRED_ERRORS.has(slackError);
