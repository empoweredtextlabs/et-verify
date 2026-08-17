import { createHash } from "node:crypto";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function canonicalize(value) {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (isRecord(value)) {
        return Object.fromEntries(Object.keys(value)
            .sort()
            .filter((key) => value[key] !== undefined)
            .map((key) => [key, canonicalize(value[key])]));
    }
    return value;
}
function sortedIssues(issues) {
    return [...issues].sort((left, right) => {
        const byCode = left.code < right.code ? -1 : left.code > right.code ? 1 : 0;
        if (byCode !== 0) {
            return byCode;
        }
        return left.message < right.message ? -1 : left.message > right.message ? 1 : 0;
    });
}
export function gitEvidencePayload(capture) {
    return {
        adapterVersion: capture.metadata.adapterVersion,
        captureStatus: capture.captureStatus,
        repository: capture.repository,
        request: capture.request,
        resolved: capture.resolved,
        changedPaths: [...capture.changedPaths],
        finalNetPatch: capture.finalNetPatch,
        workingTree: {
            ...capture.workingTree,
            entries: [...capture.workingTree.entries],
        },
        limitations: sortedIssues(capture.limitations),
        errors: sortedIssues(capture.errors),
    };
}
export function canonicalizeGitEvidence(capture) {
    return JSON.stringify(canonicalize(gitEvidencePayload(capture)));
}
export function hashCanonicalGitEvidence(capture) {
    return createHash("sha256")
        .update(canonicalizeGitEvidence(capture), "utf8")
        .digest("hex");
}
/**
 * Canonical state evidence for identities that must survive moving an
 * otherwise identical repository to another checkout path. Ambient checkout
 * paths, requested ref spellings, patch text, and working-tree state are not
 * part of this state identity.
 */
export function portableGitEvidencePayload(capture) {
    return {
        adapterVersion: capture.metadata.adapterVersion,
        captureStatus: capture.captureStatus,
        acceptanceTargetKind: capture.request.acceptanceTargetKind,
        resolved: capture.resolved,
        changedPaths: [...capture.changedPaths],
        finalNetPatch: {
            available: capture.finalNetPatch.available,
            sha256: capture.finalNetPatch.sha256,
            bytes: capture.finalNetPatch.bytes,
        },
        limitations: sortedIssues(capture.limitations),
        errors: sortedIssues(capture.errors),
    };
}
export function canonicalizePortableGitEvidence(capture) {
    return JSON.stringify(canonicalize(portableGitEvidencePayload(capture)));
}
export function hashPortableGitEvidence(capture) {
    return createHash("sha256")
        .update(canonicalizePortableGitEvidence(capture), "utf8")
        .digest("hex");
}
//# sourceMappingURL=canonicalize-git-evidence.js.map