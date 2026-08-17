import { createHash } from "node:crypto";
import { compareCanonicalStrings } from "../canonical-order.js";
import { DEFAULT_DOCUMENTATION_PATTERNS, DEFAULT_TEST_PATTERNS, isDefaultDocumentationPath, isDefaultTestPath, normalizePathSet, normalizePatternSet, pathMatchesPattern, pathMatchesPrefix, } from "./normalize-paths.js";
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
function hash(value) {
    return createHash("sha256")
        .update(JSON.stringify(canonicalize(value)))
        .digest("hex");
}
function sortStrings(values) {
    return [...new Set(values)].sort(compareCanonicalStrings);
}
function normalizedContext(value) {
    const record = isRecord(value) ? value : {};
    const claimId = typeof record.claimId === "string" ? record.claimId : "";
    const exactClaimText = typeof record.exactClaimText === "string" ? record.exactClaimText : "";
    const normalizedClaimText = typeof record.normalizedClaimText === "string"
        ? record.normalizedClaimText
        : "";
    const invalidFields = [
        ...(claimId.length === 0 ? ["claimId"] : []),
        ...(exactClaimText.length === 0 ? ["exactClaimText"] : []),
        ...(normalizedClaimText.length === 0 ? ["normalizedClaimText"] : []),
        ...(record.claimFamily !== "CF-003" ? ["claimFamily"] : []),
    ];
    return {
        context: {
            claimId,
            exactClaimText,
            normalizedClaimText,
            claimFamily: "CF-003",
        },
        limitations: invalidFields.length === 0
            ? []
            : [
                {
                    code: "scope_claim_context_invalid",
                    input: "claim_context",
                    message: `The required CF-003 claim context was invalid: ${invalidFields.join(", ")}.`,
                },
            ],
    };
}
function normalizedSource(value) {
    if (isRecord(value) &&
        value.kind === "GIT_CAPTURE_INCOMPLETE" &&
        value.limitationCode === "git_diff_capture_incomplete") {
        return {
            source: null,
            limitations: [
                {
                    code: "git_diff_capture_incomplete",
                    input: "change_set_source",
                    message: "The upstream changed-path capture was not complete, so no explicit path set was supplied for comparison.",
                },
            ],
        };
    }
    if (!isRecord(value) ||
        value.kind !== "SUPPLIED_PATH_SET" ||
        typeof value.label !== "string" ||
        value.label.length === 0) {
        return {
            source: null,
            limitations: [
                {
                    code: "scope_change_set_source_missing",
                    input: "change_set_source",
                    message: "The supplied changed-path set lacked its required SUPPLIED_PATH_SET source label.",
                },
            ],
        };
    }
    const evidence = value.evidence;
    if (evidence !== undefined) {
        if (!isRecord(evidence) ||
            evidence.kind !== "GIT_DIFF_CAPTURE" ||
            typeof evidence.captureIdentitySha256 !== "string" ||
            !/^[0-9a-f]{64}$/.test(evidence.captureIdentitySha256) ||
            typeof evidence.baseCommit !== "string" ||
            typeof evidence.headCommit !== "string" ||
            typeof evidence.baseTree !== "string" ||
            typeof evidence.headTree !== "string" ||
            ![
                "COMMIT",
                "TREE",
                "MERGE_RESULT",
                "FINAL_NET_PR_PATCH",
            ].includes(evidence.acceptanceTargetKind) ||
            typeof evidence.acceptanceTargetRef !== "string" ||
            evidence.acceptanceTargetRef.length === 0) {
            return {
                source: null,
                limitations: [
                    {
                        code: "scope_change_set_source_missing",
                        input: "change_set_source",
                        message: "The supplied changed-path set had malformed adapter capture evidence.",
                    },
                ],
            };
        }
    }
    return {
        source: {
            kind: "SUPPLIED_PATH_SET",
            label: value.label,
            ...(evidence === undefined
                ? {}
                : {
                    evidence: evidence,
                }),
        },
        limitations: [],
    };
}
function invalidClaim(message) {
    return {
        code: "scope_claim_input_invalid",
        input: "scope_claim",
        message,
    };
}
function normalizedClaim(value) {
    if (!isRecord(value) || typeof value.kind !== "string") {
        return {
            claim: null,
            limitations: [invalidClaim("A supported normalized CF-003 claim was not supplied.")],
        };
    }
    if (value.kind === "EXACT_PATH_SET") {
        const normalized = normalizePathSet(value.claimedPaths, "scope_claim");
        return {
            claim: normalized.limitations.length === 0
                ? { kind: "EXACT_PATH_SET", claimedPaths: normalized.paths }
                : null,
            limitations: normalized.limitations,
        };
    }
    if (value.kind === "PATH_PREFIX_ONLY") {
        const normalized = normalizePathSet(value.allowedPrefixes, "scope_claim");
        return {
            claim: normalized.limitations.length === 0
                ? { kind: "PATH_PREFIX_ONLY", allowedPrefixes: normalized.paths }
                : null,
            limitations: normalized.limitations,
        };
    }
    if (value.kind === "PROHIBITED_PATH_SCOPE") {
        const normalized = normalizePathSet(value.prohibitedPrefixes, "scope_claim");
        const descriptionValid = typeof value.description === "string" && value.description.length > 0;
        const limitations = [
            ...normalized.limitations,
            ...(descriptionValid
                ? []
                : [invalidClaim("A prohibited-path claim requires a non-empty description.")]),
        ];
        return {
            claim: limitations.length === 0
                ? {
                    kind: "PROHIBITED_PATH_SCOPE",
                    prohibitedPrefixes: normalized.paths,
                    description: value.description,
                }
                : null,
            limitations,
        };
    }
    if (value.kind === "DOCUMENTATION_ONLY") {
        const usesDefaultPatterns = value.documentationPatterns === undefined;
        const normalized = usesDefaultPatterns
            ? {
                patterns: sortStrings(DEFAULT_DOCUMENTATION_PATTERNS),
                limitations: [],
            }
            : normalizePatternSet(value.documentationPatterns);
        return {
            claim: normalized.limitations.length === 0
                ? {
                    kind: "DOCUMENTATION_ONLY",
                    documentationPatterns: normalized.patterns,
                    usesDefaultPatterns,
                }
                : null,
            limitations: normalized.limitations,
        };
    }
    if (value.kind === "TESTS_ONLY") {
        const usesDefaultPatterns = value.testPatterns === undefined;
        const normalized = usesDefaultPatterns
            ? { patterns: sortStrings(DEFAULT_TEST_PATTERNS), limitations: [] }
            : normalizePatternSet(value.testPatterns);
        return {
            claim: normalized.limitations.length === 0
                ? {
                    kind: "TESTS_ONLY",
                    testPatterns: normalized.patterns,
                    usesDefaultPatterns,
                }
                : null,
            limitations: normalized.limitations,
        };
    }
    if (value.kind === "CHANGED_FILE_COUNT") {
        if (typeof value.claimedCount !== "number" ||
            !Number.isInteger(value.claimedCount) ||
            value.claimedCount < 0) {
            return {
                claim: null,
                limitations: [
                    invalidClaim("The claimed changed-file count must be a non-negative integer."),
                ],
            };
        }
        return {
            claim: { kind: "CHANGED_FILE_COUNT", claimedCount: value.claimedCount },
            limitations: [],
        };
    }
    return {
        claim: null,
        limitations: [
            invalidClaim(`Unsupported normalized CF-003 claim kind: ${value.kind}.`),
        ],
    };
}
function citation(source, description, details = {}) {
    const body = { source, description, ...details };
    return {
        citationId: `cf003-change-set-${hash(body)}`,
        source,
        description,
        ...details,
    };
}
function compare(claim, actualPaths, source) {
    const mismatches = [];
    let countComparison = null;
    if (claim.kind === "EXACT_PATH_SET") {
        const claimed = new Set(claim.claimedPaths);
        const actual = new Set(actualPaths);
        for (const actualPath of actualPaths.filter((path) => !claimed.has(path))) {
            const proof = citation(source, `The supplied changed-path set includes ${actualPath}.`, { actualPath });
            mismatches.push({
                kind: "UNDISCLOSED_ACTUAL_PATH",
                normalizedClaimType: claim.kind,
                claimedOrAllowedScope: [...claim.claimedPaths],
                actualPath,
                mismatchReason: "The actual changed path was not disclosed in the claimed exact path set.",
                citation: proof,
                statement: `Actual changed path ${actualPath} was not disclosed in the claimed exact path set.`,
            });
        }
        for (const claimedPath of claim.claimedPaths.filter((path) => !actual.has(path))) {
            const proof = citation(source, `The supplied changed-path set does not include claimed path ${claimedPath}.`, { claimedPath });
            mismatches.push({
                kind: "CLAIMED_BUT_UNCHANGED_PATH",
                normalizedClaimType: claim.kind,
                claimedOrAllowedScope: [...claim.claimedPaths],
                claimedPath,
                mismatchReason: "The claimed exact path was absent from the actual changed-path set.",
                citation: proof,
                statement: `Claimed path ${claimedPath} was absent from the supplied actual changed-path set.`,
            });
        }
    }
    else if (claim.kind === "PATH_PREFIX_ONLY") {
        for (const actualPath of actualPaths.filter((path) => !claim.allowedPrefixes.some((prefix) => pathMatchesPrefix(path, prefix)))) {
            const proof = citation(source, `The supplied changed-path set includes ${actualPath}.`, { actualPath });
            mismatches.push({
                kind: "OUTSIDE_ALLOWED_PREFIX",
                normalizedClaimType: claim.kind,
                claimedOrAllowedScope: [...claim.allowedPrefixes],
                actualPath,
                mismatchReason: "The actual changed path was outside every allowed path prefix.",
                citation: proof,
                statement: `Actual changed path ${actualPath} was outside every allowed path prefix.`,
            });
        }
    }
    else if (claim.kind === "PROHIBITED_PATH_SCOPE") {
        for (const actualPath of actualPaths.filter((path) => claim.prohibitedPrefixes.some((prefix) => pathMatchesPrefix(path, prefix)))) {
            const proof = citation(source, `The supplied changed-path set includes ${actualPath}.`, { actualPath });
            mismatches.push({
                kind: "PROHIBITED_PATH",
                normalizedClaimType: claim.kind,
                claimedOrAllowedScope: [...claim.prohibitedPrefixes],
                actualPath,
                description: claim.description,
                mismatchReason: "The actual changed path fell under a prohibited path prefix.",
                citation: proof,
                statement: `Actual changed path ${actualPath} fell under the prohibited scope: ${claim.description}.`,
            });
        }
    }
    else if (claim.kind === "DOCUMENTATION_ONLY") {
        const admitted = (path) => claim.usesDefaultPatterns
            ? isDefaultDocumentationPath(path)
            : claim.documentationPatterns.some((pattern) => pathMatchesPattern(path, pattern));
        for (const actualPath of actualPaths.filter((path) => !admitted(path))) {
            const proof = citation(source, `The supplied changed-path set includes ${actualPath}.`, { actualPath });
            mismatches.push({
                kind: "NON_DOCUMENTATION_PATH",
                normalizedClaimType: claim.kind,
                claimedOrAllowedScope: [...claim.documentationPatterns],
                actualPath,
                mismatchReason: "The actual changed path did not match an admitted documentation pattern.",
                citation: proof,
                statement: `Actual changed path ${actualPath} was outside the admitted documentation patterns.`,
            });
        }
    }
    else if (claim.kind === "TESTS_ONLY") {
        const admitted = (path) => claim.usesDefaultPatterns
            ? isDefaultTestPath(path)
            : claim.testPatterns.some((pattern) => pathMatchesPattern(path, pattern));
        for (const actualPath of actualPaths.filter((path) => !admitted(path))) {
            const proof = citation(source, `The supplied changed-path set includes ${actualPath}.`, { actualPath });
            mismatches.push({
                kind: "NON_TEST_PATH",
                normalizedClaimType: claim.kind,
                claimedOrAllowedScope: [...claim.testPatterns],
                actualPath,
                mismatchReason: "The actual changed path did not match an admitted test pattern.",
                citation: proof,
                statement: `Actual changed path ${actualPath} was outside the admitted test patterns.`,
            });
        }
    }
    else {
        countComparison = {
            claimedCount: claim.claimedCount,
            actualCount: actualPaths.length,
        };
        if (claim.claimedCount !== actualPaths.length) {
            const proof = citation(source, `The supplied changed-path set contains ${actualPaths.length} unique paths.`);
            mismatches.push({
                kind: "CHANGED_FILE_COUNT_MISMATCH",
                normalizedClaimType: claim.kind,
                claimedOrAllowedScope: { claimedCount: claim.claimedCount },
                claimedCount: claim.claimedCount,
                actualCount: actualPaths.length,
                mismatchReason: "The claimed changed-file count did not equal the unique actual path count.",
                citation: proof,
                statement: `The claim stated ${claim.claimedCount} changed files; the supplied set contained ${actualPaths.length} unique paths.`,
            });
        }
    }
    return { mismatches, countComparison };
}
const MISMATCH_ORDER = {
    UNDISCLOSED_ACTUAL_PATH: 0,
    OUTSIDE_ALLOWED_PREFIX: 1,
    PROHIBITED_PATH: 2,
    NON_DOCUMENTATION_PATH: 3,
    NON_TEST_PATH: 4,
    CLAIMED_BUT_UNCHANGED_PATH: 5,
    CHANGED_FILE_COUNT_MISMATCH: 6,
};
function mismatchPath(mismatch) {
    if ("actualPath" in mismatch) {
        return mismatch.actualPath;
    }
    if ("claimedPath" in mismatch) {
        return mismatch.claimedPath;
    }
    return `${mismatch.claimedCount}\u0000${mismatch.actualCount}`;
}
function sortMismatches(mismatches) {
    return [...mismatches].sort((left, right) => MISMATCH_ORDER[left.kind] - MISMATCH_ORDER[right.kind] ||
        compareCanonicalStrings(mismatchPath(left), mismatchPath(right)));
}
function sortLimitations(limitations) {
    const unique = new Map();
    for (const limitation of limitations) {
        unique.set(JSON.stringify(canonicalize(limitation)), limitation);
    }
    return [...unique.values()].sort((left, right) => compareCanonicalStrings(left.code, right.code) ||
        compareCanonicalStrings(left.input, right.input) ||
        compareCanonicalStrings(left.path ?? "", right.path ?? "") ||
        compareCanonicalStrings(left.message, right.message));
}
function uniqueCitations(citations) {
    const unique = new Map();
    for (const entry of citations) {
        unique.set(entry.citationId, entry);
    }
    return [...unique.values()].sort((left, right) => left.citationId.localeCompare(right.citationId));
}
export function serializeClaimedScopeObservation(observation) {
    return JSON.stringify(canonicalize(observation));
}
export function observeClaimedScope(input) {
    const record = isRecord(input) ? input : {};
    const contextResult = normalizedContext(record.claimContext);
    const claimResult = normalizedClaim(record.claim);
    const changeSet = isRecord(record.actualChangeSet)
        ? record.actualChangeSet
        : {};
    const actualResult = normalizePathSet(changeSet.paths, "actual_change_set");
    const sourceResult = normalizedSource(changeSet.source);
    const limitations = sortLimitations([
        ...contextResult.limitations,
        ...claimResult.limitations,
        ...actualResult.limitations,
        ...sourceResult.limitations,
    ]);
    const comparison = limitations.length === 0 &&
        claimResult.claim !== null &&
        sourceResult.source !== null
        ? compare(claimResult.claim, actualResult.paths, sourceResult.source)
        : { mismatches: [], countComparison: null };
    const mismatches = sortMismatches(comparison.mismatches);
    const state = limitations.length > 0
        ? "INDETERMINATE"
        : mismatches.length > 0
            ? "OBSERVED"
            : "NOT_OBSERVED";
    const citations = sourceResult.source === null
        ? []
        : uniqueCitations(mismatches.length > 0
            ? mismatches.map((mismatch) => mismatch.citation)
            : [
                citation(sourceResult.source, `The supplied changed-path set contains ${actualResult.paths.length} unique paths.`),
            ]);
    const identity = hash({
        claimContext: contextResult.context,
        normalizedClaim: claimResult.claim,
        actualPaths: actualResult.paths,
        changeSetSource: sourceResult.source,
        limitations,
    });
    return {
        observationId: `cf003-${identity}`,
        observationType: "CF-003_CLAIMED_SCOPE_REALITY",
        state,
        claimContext: contextResult.context,
        normalizedClaim: claimResult.claim,
        actualPaths: actualResult.paths,
        changeSetSource: sourceResult.source,
        mismatches,
        undisclosedActualPaths: sortStrings(mismatches.flatMap((mismatch) => mismatch.kind === "UNDISCLOSED_ACTUAL_PATH" ? [mismatch.actualPath] : [])),
        claimedButUnchangedPaths: sortStrings(mismatches.flatMap((mismatch) => mismatch.kind === "CLAIMED_BUT_UNCHANGED_PATH"
            ? [mismatch.claimedPath]
            : [])),
        outOfScopeActualPaths: sortStrings(mismatches.flatMap((mismatch) => mismatch.kind === "OUTSIDE_ALLOWED_PREFIX" ? [mismatch.actualPath] : [])),
        prohibitedActualPaths: sortStrings(mismatches.flatMap((mismatch) => mismatch.kind === "PROHIBITED_PATH" ? [mismatch.actualPath] : [])),
        nonDocumentationPaths: sortStrings(mismatches.flatMap((mismatch) => mismatch.kind === "NON_DOCUMENTATION_PATH" ? [mismatch.actualPath] : [])),
        nonTestPaths: sortStrings(mismatches.flatMap((mismatch) => mismatch.kind === "NON_TEST_PATH" ? [mismatch.actualPath] : [])),
        countComparison: comparison.countComparison,
        citations,
        limitations,
    };
}
//# sourceMappingURL=observe-claimed-scope.js.map