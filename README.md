# slackcli

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Read and write Slack from your terminal with fast plain-text output and no
browser.

```console
$ slackcli inbox -n 3
● 22:15         Review Bot    checks passed
   Thread reply (2 unread) in #project-alpha  https://app.slack.com/client/E00000001/C00000001/p1700000101000000?thread_ts=1700000100.000000
  22:14         Example User  can you review this?
   Direct message in DM  https://app.slack.com/client/E00000001/D00000001/p1700000040000000
  22:13         Second User   deployment complete
   Reacted :white_check_mark: in #team-updates  https://app.slack.com/client/E00000001/C00000002/p1700000000000000
```

Most channel reads and searches use one primary API call. Channel names and
display names are cached on disk. Activity items can need extra calls to load
their full message or thread context.

## Install

Download `slackcli-0.1.0.tgz` from the `v0.1.0` release. Then install it:

```bash
npm install -g ./slackcli-0.1.0.tgz
```

Node 22 or newer. Bun works too.

## Sign in

```bash
slackcli login
```

Use the prompts for secrets. A token passed with `--token` can remain in shell
history or appear in the process list.

Two kinds of credential work.

- A **session credential**, which is what your browser holds: an `xoxc-` token
  and the `d` cookie that authorises it. This is the one that can read your
  activity feed, because that endpoint is the web client's own. To find them,
  open Slack in a browser, open the developer tools, and read `localStorage`
  (the token, under `localConfig_v2` → `teams`) and the `d` cookie.
- An **OAuth token**, `xoxp-` for a user or `xoxb-` for a bot. No cookie needed.
  Some read paths are unavailable to it, and the activity feed is one of them.

The credential is checked against `auth.test` before it is stored, so a token
Slack refuses never reaches the file. It lands in
`~/.config/slackcli/session.json` with mode `600`.

Environment variables work instead of the stored file, which is what a CI job or
a container should use:

```bash
export SLACK_TOKEN=xoxc-…        # or xoxp-… / xoxb-…
export SLACK_COOKIE='d=…'        # required with an xoxc- token
export SLACK_ORG_TOKEN=xoxc-…    # Enterprise Grid, for org-wide reads
export SLACK_HOST=acme.slack.com
```

The stored session wins over the environment, so `slackcli login` is what you
reach for on a laptop and the variables are what you set on a server.

## Commands

```bash
slackcli read project-alpha -n 20     # latest messages in a channel
slackcli thread <link> -n 10          # the newest replies in a thread
slackcli search deploy failed -n 20   # search the workspace
slackcli mentions                     # messages that mention you
slackcli mentions --unanswered        # only those you have not replied to in their thread
slackcli inbox                        # the whole activity feed: mentions, replies, DMs, reactions
slackcli send project-alpha ship it   # post, after a confirmation
slackcli reply <link> on it           # reply in a thread
slackcli users perry                  # find a user and the <@id> syntax that pings them
slackcli whoami                       # which account and credential is in use
slackcli refresh                      # rebuild the cached channel list
```

Every command takes `--json` for its normalized result. Every read takes
`--full` to print long messages instead of clamping them to four lines.

A channel accepts a name such as `project-alpha`, `#project-alpha`, or its id.
A thread is addressed by any Slack link, including the one this tool prints, or
by `C0123ABC:1700000000.000100`.

### Writing needs a yes

`send` and `reply` show the message and ask before posting. Outside a terminal
there is nobody to ask, so an unattended run has to say `--yes`:

```bash
slackcli send project-alpha "deploy finished" --yes
```

The CLI never treats silence as agreement. In unattended use, the command fails
unless you pass `--yes`.

## Enterprise Grid

Grid issues two session tokens, and neither one answers everything: the
workspace token refuses org-wide reads with `team_is_restricted`, and the org
token refuses `users.conversations` with `enterprise_is_restricted`. Set both
and the CLI tries the correct one first for each method. It uses the other token
when Slack reports the wrong scope.

## How it is built

TypeScript on [Effect](https://effect.website), Effect 4. The parts are:

- `src/domain`: the pure core. Schemas for every Slack payload, typed errors,
  thread-link parsing, Block Kit to readable text, and the row projections.
  No I/O, so it is all directly testable.
- `src/services`: `SlackCredentials`, `SlackApi` (token fallback, rate limits,
  retries), and the channel and user directories that cache name lookups.
- `src/cli`: commands, rendering, and the write confirmation.

Each known failure gives the user a clear next action. The CLI does not print
upstream payloads, tokens, or request ids.

```bash
bun install
bun test
bun run typecheck
bun run start -- inbox    # run from source
```

## License

MIT.

## Project status

This is an unofficial project. Slack Technologies, LLC does not sponsor or
maintain it.

The standard Web API paths use documented Slack endpoints. The activity feed
uses the same private endpoint as Slack's web client. Slack can change that
path without notice.
