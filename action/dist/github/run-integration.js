import { evaluatePreparedV1Acceptance, prepareV1Acceptance, } from "../v1/evaluate-acceptance.js";
import { executeTrustedChecks, } from "./execute-trusted-checks.js";
import { loadTrustedCheckConfiguration } from "./load-trusted-check-config.js";
import { resolveGitHubPullRequestIdentity } from "./resolve-pr-identity.js";
import { MERGE_QUEUE_SUPPORT, RECOMMENDED_PRODUCTION_TOPOLOGY, RUNTIME_AUTHORITY_TOPOLOGY, V1_TRUSTED_CHECK_CONFIG_PATH, } from "./types.js";
export function githubExitCode(status) {
    return status === "ACCEPTED" ? 0 : 1;
}
function reviewResult(input) {
    return {
        status: "REVIEW_REQUIRED",
        reasonCode: input.reasonCode,
        reason: input.reason,
        identity: input.identity ?? null,
        configSha256: input.configSha256 ?? null,
        checks: [],
        evaluatorResult: null,
        exitCode: 1,
        runtimeAuthorityTopology: RUNTIME_AUTHORITY_TOPOLOGY,
        recommendedProductionTopology: RECOMMENDED_PRODUCTION_TOPOLOGY,
        mergeQueueSupport: MERGE_QUEUE_SUPPORT,
    };
}
export async function runGitHubPullRequestIntegration(input, overrides = {}) {
    const identityResolution = await resolveGitHubPullRequestIdentity({
        repositoryPath: input.repositoryPath,
        eventName: input.eventName,
        eventPayload: input.eventPayload,
        ...(input.githubSha === undefined ? {} : { githubSha: input.githubSha }),
        ...(overrides.gitRunner === undefined ? {} : { runner: overrides.gitRunner }),
    });
    if (!identityResolution.ok) {
        return reviewResult(identityResolution);
    }
    const identity = identityResolution.identity;
    const config = await loadTrustedCheckConfiguration({
        repositoryPath: input.repositoryPath,
        evaluatedBaseSha: identity.evaluatedBaseSha,
        ...(overrides.gitRunner === undefined ? {} : { runner: overrides.gitRunner }),
    });
    if (!config.ok) {
        return reviewResult({ ...config, identity });
    }
    // This snapshot is deliberately complete before any PR-controlled command
    // executes. The later evaluator consumes only this trusted in-memory state.
    const prepare = overrides.prepareAcceptance ?? prepareV1Acceptance;
    const preparedState = await prepare({
        repositoryPath: input.repositoryPath,
        baseRef: identity.evaluatedBaseSha,
        headRef: identity.evaluatedHeadSha,
    });
    const capture = preparedState.capture;
    if (capture.captureStatus !== "COMPLETE" ||
        capture.resolved.baseCommit !== identity.evaluatedBaseSha ||
        capture.resolved.headCommit !== identity.evaluatedHeadSha ||
        capture.resolved.acceptanceTargetRef === null) {
        return reviewResult({
            reasonCode: "GIT_STATE_PREPARATION_FAILED",
            reason: "The exact evaluated Git state could not be captured before configured checks executed.",
            identity,
            configSha256: config.configSha256,
        });
    }
    if (capture.workingTree.clean !== true) {
        return reviewResult({
            reasonCode: "CHECKOUT_NOT_CLEAN",
            reason: "The checked-out PR head contained mutable working-tree state before trusted checks executed.",
            identity,
            configSha256: config.configSha256,
        });
    }
    const trustBaseChanged = capture.changedPaths.some((path) => path === V1_TRUSTED_CHECK_CONFIG_PATH ||
        path.startsWith(".github/workflows/"));
    const checks = await executeTrustedChecks({
        configuration: config.configuration,
        repositoryPath: input.repositoryPath,
        evaluatedHeadSha: identity.evaluatedHeadSha,
        configSha256: config.configSha256,
        runIdentity: input.runIdentity,
        ...(overrides.checkProcessExecutor === undefined
            ? {}
            : { processExecutor: overrides.checkProcessExecutor }),
    });
    const integrationReviewIssues = checks.flatMap((check) => check.state === "INDETERMINATE"
        ? [
            {
                reasonCode: "CHECK_EXECUTION_INDETERMINATE",
                summary: `Configured ${check.kind} check ${check.checkId} could not be conclusively observed (${check.indeterminateReason ?? "UNKNOWN"}).`,
            },
        ]
        : []);
    const evaluate = overrides.evaluatePreparedAcceptance ?? evaluatePreparedV1Acceptance;
    const evaluatorResult = evaluate({
        preparedState,
        trustedConfiguredChecks: config.configuration.checks.map(({ checkId, kind }) => ({ checkId, kind })),
        trustedCheckEvidence: checks.flatMap((check) => check.evidence === null ? [] : [check.evidence]),
        ...(trustBaseChanged
            ? {
                trustBaseReview: {
                    required: true,
                    reasonCode: "trust_base_changed",
                },
            }
            : {}),
        ...(integrationReviewIssues.length === 0
            ? {}
            : { integrationReviewIssues }),
    });
    const reasonCode = evaluatorResult.status === "ACCEPTED"
        ? "ACCEPTED"
        : evaluatorResult.status === "BLOCKED"
            ? "V1_BLOCKED"
            : trustBaseChanged
                ? "TRUST_BASE_CHANGED"
                : integrationReviewIssues.length > 0
                    ? "CHECK_EXECUTION_INDETERMINATE"
                    : "V1_REVIEW_REQUIRED";
    return {
        status: evaluatorResult.status,
        reasonCode,
        reason: evaluatorResult.reason,
        identity,
        configSha256: config.configSha256,
        checks,
        evaluatorResult,
        exitCode: githubExitCode(evaluatorResult.status),
        runtimeAuthorityTopology: RUNTIME_AUTHORITY_TOPOLOGY,
        recommendedProductionTopology: RECOMMENDED_PRODUCTION_TOPOLOGY,
        mergeQueueSupport: MERGE_QUEUE_SUPPORT,
    };
}
export async function runGitHubActionBoundary(run) {
    try {
        return await run();
    }
    catch {
        return reviewResult({
            reasonCode: "INTEGRATION_ERROR",
            reason: "The trusted ET integration encountered an unexpected error; the GitHub result failed closed.",
        });
    }
}
//# sourceMappingURL=run-integration.js.map