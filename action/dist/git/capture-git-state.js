import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createGitReadonlyRunner } from "./run-git-readonly.js";
import { GIT_STATE_ADAPTER_VERSION, } from "./types.js";
const ACCEPTANCE_TARGET_KINDS = new Set([
    "COMMIT",
    "TREE",
    "MERGE_RESULT",
    "FINAL_NET_PR_PATCH",
]);
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const REPOSITORY_CONFIGURATION_LIMITATION = {
    code: "repository_local_git_configuration_honored",
    message: "Repository-local Git configuration remains readable for repository semantics; executable diff, textconv, and fsmonitor surfaces used by admitted commands were explicitly disabled.",
};
const FINAL_TREE_LIMITATION = {
    code: "final_repository_tree_not_captured",
    message: "The complete final net PR patch was captured, but the complete final repository tree was not captured.",
};
const REPOSITORY_OWNERSHIP_UNTRUSTED = {
    code: "git_repository_ownership_untrusted",
    message: "Git refused to inspect this repository because the current process does not trust its ownership. Verification did not bypass Git's ownership protection.",
};
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function compareStrings(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function uniqueIssues(issues) {
    const byIdentity = new Map();
    for (const issue of issues) {
        byIdentity.set(`${issue.code}\0${issue.message}`, issue);
    }
    return [...byIdentity.values()].sort((left, right) => {
        const code = compareStrings(left.code, right.code);
        return code === 0 ? compareStrings(left.message, right.message) : code;
    });
}
function normalizedRequest(request) {
    const record = isRecord(request) ? request : {};
    const requestedPath = typeof record.repositoryPath === "string" ? record.repositoryPath : "";
    const baseRef = typeof record.baseRef === "string" ? record.baseRef : "";
    const headRef = typeof record.headRef === "string" ? record.headRef : "";
    const acceptanceTargetKind = ACCEPTANCE_TARGET_KINDS.has(record.acceptanceTargetKind)
        ? record.acceptanceTargetKind
        : null;
    const errors = [];
    if (requestedPath.trim().length === 0 || requestedPath.includes("\0")) {
        errors.push({
            code: "git_repository_path_invalid",
            message: "An explicit non-empty repository path without NUL bytes is required.",
        });
    }
    if (baseRef.trim().length === 0 || baseRef.includes("\0")) {
        errors.push({
            code: "git_base_ref_missing",
            message: "An explicit non-empty base ref without NUL bytes is required.",
        });
    }
    if (headRef.trim().length === 0 || headRef.includes("\0")) {
        errors.push({
            code: "git_head_ref_missing",
            message: "An explicit non-empty head ref without NUL bytes is required.",
        });
    }
    if (acceptanceTargetKind === null) {
        errors.push({
            code: "git_acceptance_target_kind_invalid",
            message: "A supported explicit acceptance-target kind is required.",
        });
    }
    return {
        requestedPath,
        baseRef,
        headRef,
        acceptanceTargetKind,
        errors,
    };
}
function initialResult(request, capturedAtUtc) {
    return {
        captureStatus: "FAILED",
        repository: {
            requestedPath: request.requestedPath,
            resolvedPath: null,
        },
        request: {
            baseRef: request.baseRef,
            headRef: request.headRef,
            acceptanceTargetKind: request.acceptanceTargetKind,
        },
        resolved: {
            baseCommit: null,
            headCommit: null,
            baseTree: null,
            headTree: null,
            acceptanceTargetRef: null,
        },
        changedPaths: [],
        finalNetPatch: {
            available: false,
            sha256: null,
            bytes: null,
            text: null,
        },
        workingTree: {
            inspected: false,
            clean: null,
            entries: [],
        },
        limitations: [],
        errors: [...request.errors],
        metadata: {
            adapterVersion: GIT_STATE_ADAPTER_VERSION,
            capturedAtUtc,
        },
    };
}
function failureDetail(result) {
    if (result.ok) {
        return "its output did not identify one unambiguous object";
    }
    switch (result.failureReason) {
        case "TIMED_OUT":
            return "the bounded Git command timed out";
        case "OUTPUT_LIMIT_EXCEEDED":
            return "the bounded Git command exceeded its output cap";
        case "SPAWN_FAILED":
            return "the Git process could not be started";
        case "INVALID_INVOCATION":
            return "the hardened runner rejected the invocation";
        default:
            return "Git returned a non-zero exit status";
    }
}
function runnerFailureIssue(result) {
    if (result.failureReason === "TIMED_OUT") {
        return {
            code: "git_command_timed_out",
            message: "A bounded read-only Git command timed out.",
        };
    }
    if (result.failureReason === "OUTPUT_LIMIT_EXCEEDED") {
        return {
            code: "git_command_output_limit_exceeded",
            message: "A bounded read-only Git command exceeded the configured output cap.",
        };
    }
    return null;
}
function isRepositoryOwnershipUntrusted(result) {
    if (result.ok) {
        return false;
    }
    // Git's surrounding diagnostic prose is locale-dependent. The configuration
    // token remains literal, so classification deliberately does not match any
    // translated human-readable wording.
    return result.stderr.includes(Buffer.from("safe.directory", "utf8"));
}
function decodeSingleObjectId(result) {
    if (!result.ok) {
        return null;
    }
    try {
        const value = UTF8.decode(result.stdout).trimEnd();
        return OBJECT_ID.test(value) && !value.includes("\n") && !value.includes("\r")
            ? value
            : null;
    }
    catch {
        return null;
    }
}
function decodeSinglePath(result) {
    if (!result.ok) {
        return null;
    }
    try {
        const value = UTF8.decode(result.stdout).trimEnd();
        return value.length > 0 && !value.includes("\n") && !value.includes("\r")
            ? value
            : null;
    }
    catch {
        return null;
    }
}
function sameResolvedPath(left, right) {
    const delta = relative(resolve(left), resolve(right));
    return delta.length === 0;
}
function normalizeChangedPath(path) {
    const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
    if (normalized.length === 0 ||
        normalized.includes("\0") ||
        normalized.startsWith("/") ||
        /^[A-Za-z]:\//.test(normalized) ||
        normalized.startsWith("//") ||
        normalized.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
        return null;
    }
    return normalized;
}
function parseNulPaths(buffer) {
    if (buffer.byteLength === 0) {
        return [];
    }
    if (buffer[buffer.byteLength - 1] !== 0) {
        return null;
    }
    const paths = [];
    let start = 0;
    for (let index = 0; index < buffer.byteLength; index += 1) {
        if (buffer[index] !== 0) {
            continue;
        }
        if (index === start) {
            return null;
        }
        let decoded;
        try {
            decoded = UTF8.decode(buffer.subarray(start, index));
        }
        catch {
            return null;
        }
        const normalized = normalizeChangedPath(decoded);
        if (normalized === null) {
            return null;
        }
        paths.push(normalized);
        start = index + 1;
    }
    return [...new Set(paths)].sort(compareStrings);
}
function parseStatusEntries(buffer) {
    if (buffer.byteLength === 0) {
        return [];
    }
    if (buffer[buffer.byteLength - 1] !== 0) {
        return null;
    }
    const entries = [];
    let start = 0;
    for (let index = 0; index < buffer.byteLength; index += 1) {
        if (buffer[index] !== 0) {
            continue;
        }
        if (index === start) {
            return null;
        }
        try {
            entries.push(UTF8.decode(buffer.subarray(start, index)));
        }
        catch {
            return null;
        }
        start = index + 1;
    }
    return [...new Set(entries)].sort(compareStrings);
}
async function explicitRepositoryPath(requestedPath) {
    let resolvedPath;
    try {
        const info = await lstat(requestedPath);
        if (!info.isDirectory()) {
            return {
                resolvedPath: null,
                error: {
                    code: "git_repository_path_invalid",
                    message: "The supplied repository path is not a directory.",
                },
            };
        }
        resolvedPath = await realpath(requestedPath);
    }
    catch (error) {
        const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
        return {
            resolvedPath: null,
            error: {
                code: code === "ENOENT"
                    ? "git_repository_not_found"
                    : "git_repository_path_invalid",
                message: code === "ENOENT"
                    ? "The supplied repository path does not exist."
                    : "The supplied repository path could not be resolved safely.",
            },
        };
    }
    try {
        await lstat(join(resolvedPath, ".git"));
    }
    catch {
        return {
            resolvedPath,
            error: {
                code: "git_repository_not_a_repository",
                message: "The supplied path is not an explicit Git working-tree root; parent-directory discovery is not used.",
            },
        };
    }
    return { resolvedPath, error: null };
}
function addCommandFailure(errors, result, issue) {
    errors.push(issue);
    const runnerIssue = runnerFailureIssue(result);
    if (runnerIssue !== null) {
        errors.push(runnerIssue);
    }
}
async function captureGitStateInternal(captureRequest, options) {
    const request = normalizedRequest(captureRequest);
    const now = options.now ?? (() => new Date());
    const result = initialResult(request, now().toISOString());
    if (result.errors.length > 0) {
        result.errors = uniqueIssues(result.errors);
        return result;
    }
    const repository = await explicitRepositoryPath(request.requestedPath);
    result.repository.resolvedPath = repository.resolvedPath;
    if (repository.error !== null || repository.resolvedPath === null) {
        if (repository.error !== null) {
            result.errors.push(repository.error);
        }
        result.errors = uniqueIssues(result.errors);
        return result;
    }
    const runner = createGitReadonlyRunner(options.readonlyRunnerOptions);
    const rootResult = await runner.run(repository.resolvedPath, [
        "rev-parse",
        "--show-toplevel",
    ]);
    const root = decodeSinglePath(rootResult);
    if (root === null || !sameResolvedPath(root, repository.resolvedPath)) {
        if (isRepositoryOwnershipUntrusted(rootResult)) {
            result.errors.push(REPOSITORY_OWNERSHIP_UNTRUSTED);
        }
        else {
            addCommandFailure(result.errors, rootResult, {
                code: "git_repository_not_a_repository",
                message: "The supplied path could not be verified as the exact Git working-tree root.",
            });
        }
        result.errors = uniqueIssues(result.errors);
        return result;
    }
    const [baseResult, headResult] = await Promise.all([
        runner.run(repository.resolvedPath, [
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${request.baseRef}^{commit}`,
        ]),
        runner.run(repository.resolvedPath, [
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${request.headRef}^{commit}`,
        ]),
    ]);
    result.resolved.baseCommit = decodeSingleObjectId(baseResult);
    result.resolved.headCommit = decodeSingleObjectId(headResult);
    if (result.resolved.baseCommit === null) {
        addCommandFailure(result.errors, baseResult, {
            code: "git_base_ref_unresolved",
            message: `The explicit base ref could not be resolved unambiguously because ${failureDetail(baseResult)}.`,
        });
    }
    if (result.resolved.headCommit === null) {
        addCommandFailure(result.errors, headResult, {
            code: "git_head_ref_unresolved",
            message: `The explicit head ref could not be resolved unambiguously because ${failureDetail(headResult)}.`,
        });
    }
    if (result.resolved.baseCommit === null || result.resolved.headCommit === null) {
        result.errors = uniqueIssues(result.errors);
        return result;
    }
    const [baseTreeResult, headTreeResult] = await Promise.all([
        runner.run(repository.resolvedPath, [
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${result.resolved.baseCommit}^{tree}`,
        ]),
        runner.run(repository.resolvedPath, [
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${result.resolved.headCommit}^{tree}`,
        ]),
    ]);
    result.resolved.baseTree = decodeSingleObjectId(baseTreeResult);
    result.resolved.headTree = decodeSingleObjectId(headTreeResult);
    if (result.resolved.baseTree === null || result.resolved.headTree === null) {
        addCommandFailure(result.errors, baseTreeResult, {
            code: "git_ref_tree_resolution_failed",
            message: "The resolved base or head commit tree could not be captured.",
        });
        const runnerIssue = runnerFailureIssue(headTreeResult);
        if (runnerIssue !== null) {
            result.errors.push(runnerIssue);
        }
        result.errors = uniqueIssues(result.errors);
        return result;
    }
    const baseCommit = result.resolved.baseCommit;
    const headCommit = result.resolved.headCommit;
    const [pathsResult, patchResult, statusResult] = await Promise.all([
        runner.run(repository.resolvedPath, [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--name-only",
            "-z",
            baseCommit,
            headCommit,
        ]),
        runner.run(repository.resolvedPath, [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--binary",
            "--no-renames",
            "--no-color",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--submodule=short",
            baseCommit,
            headCommit,
        ]),
        runner.run(repository.resolvedPath, [
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
        ]),
    ]);
    const parsedPaths = pathsResult.ok ? parseNulPaths(pathsResult.stdout) : null;
    if (!pathsResult.ok) {
        addCommandFailure(result.errors, pathsResult, {
            code: "git_diff_capture_failed",
            message: `The changed-path diff could not be captured because ${failureDetail(pathsResult)}.`,
        });
    }
    else if (parsedPaths === null) {
        result.errors.push({
            code: "git_diff_capture_incomplete",
            message: "The NUL-delimited changed-path output was malformed or not exact UTF-8.",
        });
    }
    else {
        result.changedPaths = parsedPaths;
    }
    if (!patchResult.ok) {
        addCommandFailure(result.errors, patchResult, {
            code: "git_patch_capture_failed",
            message: `The final net patch could not be captured because ${failureDetail(patchResult)}.`,
        });
    }
    else {
        try {
            const patchText = UTF8.decode(patchResult.stdout);
            result.finalNetPatch = {
                available: true,
                sha256: createHash("sha256").update(patchResult.stdout).digest("hex"),
                bytes: patchResult.stdout.byteLength,
                text: patchText,
            };
        }
        catch {
            result.errors.push({
                code: "git_patch_capture_failed",
                message: "The exact patch bytes were not valid UTF-8 and could not be represented without rewriting them.",
            });
        }
    }
    const statusEntries = statusResult.ok
        ? parseStatusEntries(statusResult.stdout)
        : null;
    if (statusEntries === null) {
        addCommandFailure(result.errors, statusResult, {
            code: "git_working_tree_capture_failed",
            message: "The informational working-tree status could not be captured completely.",
        });
    }
    else {
        result.workingTree = {
            inspected: true,
            clean: statusEntries.length === 0,
            entries: statusEntries,
        };
        if (statusEntries.length > 0) {
            result.limitations.push({
                code: "working_tree_contains_uncommitted_changes",
                message: "The working tree contains uncommitted changes; the captured diff compares only the resolved refs and excludes ambient working-tree content.",
            });
        }
    }
    if (request.acceptanceTargetKind === "COMMIT") {
        result.resolved.acceptanceTargetRef = result.resolved.headCommit;
    }
    else if (request.acceptanceTargetKind === "TREE") {
        result.resolved.acceptanceTargetRef = result.resolved.headTree;
    }
    else if (request.acceptanceTargetKind === "MERGE_RESULT") {
        result.resolved.acceptanceTargetRef = result.resolved.headCommit;
        result.limitations.push({
            code: "merge_result_not_synthesized",
            message: "No merge was synthesized; the explicitly supplied head ref is treated as the intended pre-existing merge-result commit.",
        });
    }
    else if (request.acceptanceTargetKind === "FINAL_NET_PR_PATCH" &&
        result.finalNetPatch.sha256 !== null) {
        result.resolved.acceptanceTargetRef = `sha256:${result.finalNetPatch.sha256}`;
        result.limitations.push(FINAL_TREE_LIMITATION);
    }
    result.limitations.push(REPOSITORY_CONFIGURATION_LIMITATION);
    const decisiveFailure = result.errors.some((issue) => [
        "git_diff_capture_failed",
        "git_patch_capture_failed",
        "git_command_timed_out",
        "git_command_output_limit_exceeded",
    ].includes(issue.code));
    result.captureStatus =
        result.errors.length === 0
            ? "COMPLETE"
            : decisiveFailure
                ? "FAILED"
                : "INCOMPLETE";
    result.limitations = uniqueIssues(result.limitations);
    result.errors = uniqueIssues(result.errors);
    return result;
}
export async function captureGitState(captureRequest) {
    return await captureGitStateInternal(captureRequest, {});
}
/** @internal Test-only fault injection; not exported from the public package index. */
export async function captureGitStateWithTestOverrides(captureRequest, options) {
    return await captureGitStateInternal(captureRequest, options);
}
//# sourceMappingURL=capture-git-state.js.map