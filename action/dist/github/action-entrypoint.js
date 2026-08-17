import { readFile, stat } from "node:fs/promises";
import { publishGitHubActionResult } from "./action-output.js";
import { runGitHubActionBoundary, runGitHubPullRequestIntegration, } from "./run-integration.js";
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
function requiredEnvironment(name) {
    const value = process.env[name];
    if (value === undefined || value.length === 0) {
        throw new Error(`Required GitHub environment value ${name} was unavailable.`);
    }
    return value;
}
async function loadEvent(path) {
    const details = await stat(path);
    if (!details.isFile() || details.size > MAX_EVENT_BYTES) {
        throw new Error("The GitHub event payload was not a bounded regular file.");
    }
    return JSON.parse(await readFile(path, "utf8"));
}
let result = await runGitHubActionBoundary(async () => {
    const eventPath = requiredEnvironment("GITHUB_EVENT_PATH");
    const eventPayload = await loadEvent(eventPath);
    const runId = requiredEnvironment("GITHUB_RUN_ID");
    const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
    return await runGitHubPullRequestIntegration({
        repositoryPath: requiredEnvironment("GITHUB_WORKSPACE"),
        eventName: requiredEnvironment("GITHUB_EVENT_NAME"),
        eventPayload,
        ...(process.env.GITHUB_SHA === undefined
            ? {}
            : { githubSha: process.env.GITHUB_SHA }),
        runIdentity: `github:${runId}:${runAttempt}`,
    });
});
result = await publishGitHubActionResult(result, {
    outputPath: process.env.GITHUB_OUTPUT,
    summaryPath: process.env.GITHUB_STEP_SUMMARY,
});
if (result.status !== "ACCEPTED") {
    process.stdout.write(`::error title=ET Verify ${result.status}::${result.reasonCode}: ${result.reason}\n`);
}
process.exitCode = result.exitCode;
//# sourceMappingURL=action-entrypoint.js.map