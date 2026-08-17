import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

// This proof deliberately imports only the committed packaged Action runtime.
import { renderGitHubSummary } from "../action/dist/github/render-summary.js";
import { runGitHubPullRequestIntegration } from "../action/dist/github/run-integration.js";

const ACCEPTANCE_PATH = ".et-verify/acceptance.json";
const CONFIG_PATH = ".et-verify/checks.json";

function runGit(repositoryPath, args) {
  const result = spawnSync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
  );
  return result.stdout.trim();
}

async function write(repositoryPath, relativePath, content) {
  const destination = join(repositoryPath, ...relativePath.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, "utf8");
}

function commitAll(repositoryPath, message) {
  runGit(repositoryPath, ["add", "--all"]);
  runGit(repositoryPath, [
    "-c",
    "user.name=ET Consumer",
    "-c",
    "user.email=consumer@example.invalid",
    "commit",
    "-q",
    "-m",
    message,
  ]);
  return runGit(repositoryPath, ["rev-parse", "HEAD"]);
}

async function createConsumer(t, scenario) {
  const repositoryPath = await mkdtemp(join(tmpdir(), "et-verify-v1-consumer-"));
  t.after(async () => await rm(repositoryPath, { recursive: true, force: true }));

  runGit(repositoryPath, ["init", "-q", "-b", "main"]);
  await write(
    repositoryPath,
    CONFIG_PATH,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        checks: [
          {
            checkId: "test",
            kind: "TEST",
            command: "NODE",
            args: ["checks/pass.mjs"],
            timeoutMs: 5000,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await write(repositoryPath, "checks/pass.mjs", "process.exit(0);\n");
  await write(repositoryPath, "README.md", "# External consumer fixture\n");
  const baseCommit = commitAll(repositoryPath, "trusted base configuration");

  runGit(repositoryPath, ["checkout", "-q", "-b", "agent-pr"]);
  await write(repositoryPath, "src/change.js", "export const changed = true;\n");
  if (scenario === "BLOCKED") {
    await write(
      repositoryPath,
      "src/undeclared.js",
      "export const notDeclared = true;\n",
    );
  }
  if (scenario !== "REVIEW_REQUIRED") {
    await write(
      repositoryPath,
      ACCEPTANCE_PATH,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          baseCommit,
          changeScope: {
            kind: "EXACT_PATH_SET",
            paths: [ACCEPTANCE_PATH, "src/change.js"],
          },
          checkResults: [
            { checkId: "test", kind: "TEST", declaredResult: "PASS" },
          ],
        },
        null,
        2,
      )}\n`,
    );
  }
  const headCommit = commitAll(repositoryPath, `agent PR ${scenario}`);
  const computedBase = runGit(repositoryPath, [
    "merge-base",
    baseCommit,
    headCommit,
  ]);
  assert.equal(computedBase, baseCommit);

  const result = await runGitHubPullRequestIntegration({
    repositoryPath,
    eventName: "pull_request",
    eventPayload: {
      pull_request: {
        base: { sha: baseCommit },
        head: { sha: headCommit },
      },
    },
    runIdentity: `local-consumer:${scenario.toLowerCase()}:1`,
  });
  return { repositoryPath, result, summary: renderGitHubSummary(result) };
}

function assertHumanSurface(summary, status) {
  const display = status === "REVIEW_REQUIRED" ? "REVIEW REQUIRED" : status;
  assert.match(summary, new RegExp(`^# ET VERIFY — ${display}$`, "m"));
  assert.match(summary, /^## AGENT CLAIMED$/m);
  assert.match(summary, /^## ET ESTABLISHED$/m);
  assert.match(summary, /^## Required human action$/m);
  assert.match(summary, /^## Check and scope evidence$/m);
  assert.match(summary, /<details>[\s\S]*<summary>Identity and limitations<\/summary>/);
}

test("external consumer: valid declaration and passing trusted check are ACCEPTED", async (t) => {
  const { result, summary } = await createConsumer(t, "ACCEPTED");
  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.exitCode, 0);
  assert.equal(result.evaluatorResult?.etEstablished.stateBinding, "BOUND");
  assert.equal(result.evaluatorResult?.etEstablished.scopeState, "MATCH");
  assert.equal(result.checks[0]?.state, "PASS");
  assertHumanSurface(summary, "ACCEPTED");
});

test("external consumer: missing declaration is REVIEW REQUIRED", async (t) => {
  const { result, summary } = await createConsumer(t, "REVIEW_REQUIRED");
  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.equal(result.exitCode, 1);
  assert.equal(result.evaluatorResult?.etEstablished.declarationState, "MISSING");
  assert.match(
    result.evaluatorResult?.issues.map((issue) => issue.code).join("\n") ?? "",
    /acceptance_declaration_missing/,
  );
  assertHumanSurface(summary, "REVIEW_REQUIRED");
});

test("external consumer: undeclared changed path is BLOCKED", async (t) => {
  const { result, summary } = await createConsumer(t, "BLOCKED");
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.exitCode, 1);
  assert.equal(result.evaluatorResult?.etEstablished.scopeState, "MISMATCH");
  assert.match(
    result.evaluatorResult?.issues.map((issue) => issue.code).join("\n") ?? "",
    /acceptance_exact_path_set_mismatch/,
  );
  assertHumanSurface(summary, "BLOCKED");
});

