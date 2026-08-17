import { createHash } from "node:crypto";
const MAPPING_VERSION = "cf003-semantic-finding-v1";
function canonicalize(value) {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (typeof value === "object" && value !== null) {
        const record = value;
        return Object.fromEntries(Object.keys(record)
            .sort()
            .filter((key) => record[key] !== undefined)
            .map((key) => [key, canonicalize(record[key])]));
    }
    return value;
}
function findingIdentity(observation) {
    const identity = JSON.stringify(canonicalize({
        mappingVersion: MAPPING_VERSION,
        observationId: observation.observationId,
        claimContext: observation.claimContext,
    }));
    return `cf003-finding-${createHash("sha256").update(identity).digest("hex")}`;
}
function baseFinding(observation) {
    return {
        findingId: findingIdentity(observation),
        findingType: "CLAIMED_SCOPE_REALITY",
        claimId: observation.claimContext.claimId,
        exactClaimText: observation.claimContext.exactClaimText,
        normalizedClaim: observation.claimContext.normalizedClaimText,
        claimFamily: "CF-003",
        defectId: "claimed_scope_mismatch",
        observationState: observation.state,
        metadata: {
            adjudicationMethod: "deterministic",
            mappingVersion: MAPPING_VERSION,
            sourceObservationId: observation.observationId,
            sourceObservationType: observation.observationType,
            normalizedClaimType: observation.normalizedClaim?.kind ?? null,
            observationBinding: {
                claimId: observation.claimContext.claimId,
                changeSetSource: observation.changeSetSource,
            },
        },
    };
}
function observedFinding(observation) {
    const decisiveFacts = observation.mismatches.map((mismatch, index) => ({
        kind: "CLAIMED_SCOPE_MISMATCH",
        factId: `${observation.observationId}:mismatch:${index + 1}`,
        mismatch,
    }));
    const mismatchCount = decisiveFacts.length;
    return {
        ...baseFinding(observation),
        verdict: "PARTIALLY_SUPPORTED",
        consequence: "REPAIR_REQUIRED",
        summary: `The supplied actual changed-path set did not fully match the normalized ${observation.normalizedClaim?.kind ?? "CF-003"} claim. ${mismatchCount} material scope mismatch${mismatchCount === 1 ? " was" : "es were"} established from the supplied set.`,
        decisiveFacts,
        citations: [...observation.citations],
        limitations: [
            {
                code: "bounded_cf003_supplied_path_scope",
                message: "This finding is limited to the normalized claim type and explicit changed-path set supplied to CF-003.",
            },
        ],
        prohibitedConclusions: [
            "the agent intended to conceal changes",
            "every reported statement is false",
            "the changed code is incorrect",
            "the out-of-scope change caused a defect",
            "the work must never be merged",
        ],
        requiredAction: [
            "Correct the report to match the actual changed scope, or revert or separate the out-of-scope changes.",
            "Rerun verification against the resulting final changed-path set.",
        ],
        whatWouldChangeThis: [
            "The claim was corrected to match the supplied actual changed-path set.",
            "The actual changed-path set was changed to satisfy the stated scope.",
        ],
    };
}
function notObservedFinding(observation) {
    const normalizedClaim = observation.normalizedClaim;
    const sourceCitation = observation.citations[0];
    const decisiveFact = {
        kind: "CLAIMED_SCOPE_BOUNDED_COMPARISON",
        factId: `${observation.observationId}:bounded-comparison`,
        normalizedClaim,
        actualPaths: [...observation.actualPaths],
        citation: sourceCitation,
        statement: "No admitted mismatch was observed between the normalized scope claim and the supplied actual changed-path set.",
    };
    return {
        ...baseFinding(observation),
        verdict: "NO_MATERIAL_FINDING",
        consequence: "ACCEPT",
        summary: "No admitted scope mismatch was observed for the normalized claim type and supplied changed-path set.",
        decisiveFacts: [decisiveFact],
        citations: [...observation.citations],
        limitations: [
            {
                code: "bounded_cf003_supplied_path_scope",
                message: "This result is limited to the supplied changed-path set and normalized claim type; it does not establish code correctness, test success, or behavioral safety.",
            },
        ],
        prohibitedConclusions: [
            "all implementation claims are true",
            "the code is correct",
            "tests passed",
            "no breaking change exists",
            "no other undisclosed evidence issue exists",
        ],
        requiredAction: [],
        whatWouldChangeThis: [
            "A different final changed-path set introduced an admitted scope mismatch.",
            "The normalized claim was changed such that the supplied path set no longer satisfied it.",
        ],
    };
}
function indeterminateLimitations(observation) {
    return observation.limitations.map((limitation) => ({
        code: limitation.code,
        message: limitation.message,
    }));
}
function indeterminateFinding(observation) {
    const limitationCodes = observation.limitations.map((limitation) => limitation.code);
    const decisiveFact = {
        kind: "CLAIMED_SCOPE_INDETERMINATE_INPUTS",
        factId: `${observation.observationId}:indeterminate-inputs`,
        limitationCodes,
        safelyNormalizedActualPaths: [...observation.actualPaths],
        statement: "The scope claim could not be compared safely because required input was absent, malformed, or unsupported.",
    };
    return {
        ...baseFinding(observation),
        verdict: "HUMAN_JUDGMENT_REQUIRED",
        consequence: "REVIEW_REQUIRED",
        summary: "Claimed change scope could not be compared safely from the supplied inputs.",
        decisiveFacts: [decisiveFact],
        citations: [...observation.citations],
        limitations: indeterminateLimitations(observation),
        prohibitedConclusions: [
            "the claim matched",
            "no scope defect exists",
            "absence of usable path evidence proves compliance",
        ],
        requiredAction: [
            "Supply or repair the exact input named in the limitations, then rerun CF-003 verification.",
        ],
        whatWouldChangeThis: [
            "A valid normalized claim, explicit claim context, and labeled supplied changed-path set were available for deterministic comparison.",
        ],
    };
}
export function serializeClaimedScopeFinding(finding) {
    return JSON.stringify(canonicalize(finding));
}
export function adjudicateClaimedScope(observation) {
    if (observation.state === "OBSERVED") {
        return observedFinding(observation);
    }
    if (observation.state === "NOT_OBSERVED") {
        return notObservedFinding(observation);
    }
    return indeterminateFinding(observation);
}
//# sourceMappingURL=adjudicate-claimed-scope.js.map