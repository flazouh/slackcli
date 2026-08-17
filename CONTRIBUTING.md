# Contributing

Bug reports and small pull requests are welcome. Open an issue before a large change so the design can be agreed first.

## Local checks

Use Node.js 22 or later and Bun 1.3.13.

```bash
bun install --frozen-lockfile
bun run check
```

Test behavior through the public service or CLI boundary. Decode Slack data with an Effect Schema before application code reads it.

## Pull requests

Explain the behavior that changed. Include the check output and keep the pull request focused on one problem.

Never commit a Slack token, cookie, session file, API response, or private message.
