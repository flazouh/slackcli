# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Report a problem

Use this repository's private vulnerability reporting page.
Do not open a public issue for a security problem.

Include the affected version, the command, and a small reproduction. Remove
Slack tokens, cookies, request data, home paths, and message content first.

`slackcli login` stores the session in `~/.config/slackcli/session.json` with
owner-only permissions. Environment credentials stay in the process environment.

Use the interactive login prompts for secrets. Command flags can remain in
shell history or appear in the process list.
