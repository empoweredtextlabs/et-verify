import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ET_RESULT_JSON_OUTPUT_NAME,
  ET_STATUS_OUTPUT_NAME,
  serializeGitHubIntegrationResult,
  writeGitHubActionOutputs,
} from "../action/dist/github/action-output.js";
import { renderGitHubSummary } from "../action/dist/github/render-summary.js";
import {
  githubExitCode,
  runGitHubActionBoundary,
} from "../action/dist/github/run-integration.js";

test("packaged Action keeps every non-accepted state non-passing", async () => {
  assert.equal(githubExitCode("ACCEPTED"), 0);
  assert.equal(githubExitCode("REVIEW_REQUIRED"), 1);
  assert.equal(githubExitCode("BLOCKED"), 1);

  const failure = await runGitHubActionBoundary(async () => {
    throw new Error("smoke failure");
  });
  assert.equal(failure.status, "REVIEW_REQUIRED");
  assert.equal(failure.reasonCode, "INTEGRATION_ERROR");
  assert.equal(failure.exitCode, 1);
  assert.equal(failure.runtimeAuthorityTopology, "NOT_ESTABLISHED_BY_ACTION_RUN");
  assert.equal(
    failure.recommendedProductionTopology,
    "ORGANIZATION_RULESET_REQUIRED_WORKFLOW",
  );
  assert.equal(
    failure.mergeQueueSupport,
    "MERGE_QUEUE_NOT_SUPPORTED_IN_V1_ALPHA",
  );
  assert.equal(Object.hasOwn(failure, "authorityTopology"), false);

  const summary = renderGitHubSummary(failure);
  assert.match(summary, /^# ET VERIFY — REVIEW REQUIRED/m);
  assert.match(
    summary,
    /Runtime authority topology: `NOT_ESTABLISHED_BY_ACTION_RUN`/,
  );
  assert.match(
    summary,
    /Recommended production topology: `ORGANIZATION_RULESET_REQUIRED_WORKFLOW`/,
  );
});

test("packaged Action declares and exposes a machine-readable result", async () => {
  const metadata = await readFile(new URL("../action.yml", import.meta.url), "utf8");
  assert.match(metadata, /^  et-status:\r?$/m);
  assert.match(metadata, /^  et-result-json:\r?$/m);

  const result = await runGitHubActionBoundary(async () => {
    throw new Error("consumer fixture");
  });
  let channel = Buffer.alloc(0);
  await writeGitHubActionOutputs(result, {
    outputPath: "output-channel",
    appendOutput: async (_path, record) => {
      channel = Buffer.concat([channel, record]);
    },
  });
  const outputs = new Map(
    channel
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  assert.equal(outputs.get(ET_STATUS_OUTPUT_NAME), "REVIEW_REQUIRED");
  const serialized = outputs.get(ET_RESULT_JSON_OUTPUT_NAME);
  assert.equal(serialized, serializeGitHubIntegrationResult(result));

  const machineResult = JSON.parse(serialized);
  assert.equal(machineResult.status, "REVIEW_REQUIRED");
  assert.equal(
    machineResult.runtimeAuthorityTopology,
    "NOT_ESTABLISHED_BY_ACTION_RUN",
  );
  assert.equal(
    machineResult.recommendedProductionTopology,
    "ORGANIZATION_RULESET_REQUIRED_WORKFLOW",
  );
  assert.equal(Object.hasOwn(machineResult, "authorityTopology"), false);
  assert.equal(
    machineResult.mergeQueueSupport,
    "MERGE_QUEUE_NOT_SUPPORTED_IN_V1_ALPHA",
  );
});
