import { createGitReadonlyRunner } from "../git/run-git-readonly.js";
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function eventCommit(payload, side) {
    if (!isRecord(payload) || !isRecord(payload.pull_request)) {
        return null;
    }
    const candidate = payload.pull_request[side];
    if (!isRecord(candidate) || typeof candidate.sha !== "string") {
        return null;
    }
    return COMMIT_SHA.test(candidate.sha) ? candidate.sha : null;
}
function decodeCommitSha(bytes) {
    try {
        const value = UTF8.decode(bytes).trimEnd();
        return COMMIT_SHA.test(value) && !value.includes("\n") && !value.includes("\r")
            ? value
            : null;
    }
    catch {
        return null;
    }
}
function failure(reasonCode, reason) {
    return { ok: false, reasonCode, reason };
}
export async function resolveGitHubPullRequestIdentity(input) {
    if (input.eventName !== "pull_request") {
        return failure("UNSUPPORTED_GITHUB_EVENT", "V1 alpha supports pull_request only; merge_group and all other events fail closed.");
    }
    const githubBaseTipSha = eventCommit(input.eventPayload, "base");
    const githubHeadSha = eventCommit(input.eventPayload, "head");
    if (githubBaseTipSha === null || githubHeadSha === null) {
        return failure("GITHUB_EVENT_IDENTITY_INVALID", "The pull request event did not contain canonical full base-tip and head commit SHAs.");
    }
    if (input.githubSha !== undefined && input.githubSha === githubHeadSha) {
        return failure("SYNTHETIC_MERGE_HEAD_REJECTED", "The evaluated head must come from pull_request.head.sha and must not be the GitHub merge-ref identity.");
    }
    const runner = input.runner ?? createGitReadonlyRunner();
    const checkedOut = await runner.run(input.repositoryPath, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        "HEAD^{commit}",
    ]);
    if (decodeCommitSha(checkedOut.stdout) !== githubHeadSha) {
        return failure("CHECKED_OUT_HEAD_MISMATCH", "The checked-out HEAD did not equal the exact pull_request.head.sha.");
    }
    const mergeBase = await runner.run(input.repositoryPath, [
        "merge-base",
        githubBaseTipSha,
        githubHeadSha,
    ]);
    const evaluatedBaseSha = decodeCommitSha(mergeBase.stdout);
    if (!mergeBase.ok || evaluatedBaseSha === null) {
        return failure("MERGE_BASE_UNAVAILABLE", "The PR merge-base could not be established from complete local history; no base-tip fallback was used.");
    }
    const identity = {
        githubBaseTipSha,
        githubHeadSha,
        evaluatedBaseSha,
        evaluatedHeadSha: githubHeadSha,
        acceptanceTargetRef: githubHeadSha,
    };
    return { ok: true, identity };
}
//# sourceMappingURL=resolve-pr-identity.js.map