import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

const runCli = async (args: ReadonlyArray<string>) => {
  const config = mkdtempSync(join(tmpdir(), "slackcli-command-"));
  const env: Record<string, string | undefined> = { ...process.env, XDG_CONFIG_HOME: config };
  delete env["SLACK_TOKEN"];
  delete env["SLACK_COOKIE"];
  delete env["SLACK_ORG_TOKEN"];

  const child = Bun.spawn(["bun", "run", "src/bin/slackcli.ts", ...args], {
    cwd: join(import.meta.dir, "../.."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(child.stderr).text();
  return { exitCode: await child.exited, stderr };
};

test("the CLI rejects a non-positive item limit before it starts a command", async () => {
  const result = await runCli(["read", "general", "--limit", "0"]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Expected a positive item limit");
});

test("an unattended write fails before it reads credentials", async () => {
  const result = await runCli(["send", "general", "ship", "it"]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Nothing was sent");
  expect(result.stderr).toContain("with --yes to post it");
});
