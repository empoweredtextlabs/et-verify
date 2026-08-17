import { compareCanonicalStrings } from "../canonical-order.js";
import { adjudicateClaimedScope } from "../cf003/adjudicate-claimed-scope.js";
import { observeClaimedScope } from "../cf003/observe-claimed-scope.js";
import { hashPortableGitEvidence } from "../git/canonicalize-git-evidence.js";
import { captureGitState } from "../git/capture-git-state.js";
import { canonicalV1Json, hashV1Value } from "./canonicalize.js";
import { loadV1AcceptanceDeclarationFromHead, } from "./load-acceptance-declaration.js";
import { evaluateTrustedCheckEvidence, loadV1CheckEvidence, } from "./load-check-evidence.js";
import { V1_ACCEPTANCE_CONTRACT_VERSION, V1_ACCEPTANCE_DECLARATION_PATH, } from "./types.js";
const SCOPE_CLAIM_TEXT = "The committed V1 acceptance declaration lists the complete final changed-path set.";
function issue(code, status, summary) {
    return { code, status, summary };
}
function unavailableDeclarationLoad() {
    return {
        state: "UNAVAILABLE",
        declaration: null,
        headBlobGitObjectId: null,
        headBlobSha256: null,
        headBlobBytes: null,
        baseBlobGitObjectId: null,
        changedFromBase: null,
        issues: [
            issue("acceptance_declaration_state_unavailable", "REVIEW_REQUIRED", "The declaration could not be read from HEAD because the evaluated Git state was unavailable."),
        ],
    };
}
function uniqueIssues(issues) {
    const unique = new Map();
    for (const candidate of issues) {
        unique.set(canonicalV1Json(candidate), candidate);
    }
    return [...unique.values()].sort((left, right) => (left.status === right.status ? 0 : left.status === "BLOCKED" ? -1 : 1) ||
        compareCanonicalStrings(left.code, right.code) ||
        compareCanonicalStrings(left.summary, right.summary));
}
function portableChangeSet(capture) {
    const resolved = capture.resolved;
    if (capture.captureStatus !== "COMPLETE" ||
        resolved.baseCommit === null ||
        resolved.headCommit === null ||
        resolved.baseTree === null ||
        resolved.headTree === null ||
        resolved.acceptanceTargetRef === null ||
        capture.request.acceptanceTargetKind !== "FINAL_NET_PR_PATCH") {
        return {
            paths: [],
            source: {
                kind: "GIT_CAPTURE_INCOMPLETE",
                label: "incomplete Git changed-path capture",
                limitationCode: "git_diff_capture_incomplete",
            },
        };
    }
    return {
        paths: [...capture.changedPaths],
        source: {
            kind: "SUPPLIED_PATH_SET",
            label: `git diff ${resolved.baseCommit}..${resolved.headCommit}`,
            evidence: {
                kind: "GIT_DIFF_CAPTURE",
                captureIdentitySha256: hashPortableGitEvidence(capture),
                baseCommit: resolved.baseCommit,
                headCommit: resolved.headCommit,
                baseTree: resolved.baseTree,
                headTree: resolved.headTree,
                acceptanceTargetKind: "FINAL_NET_PR_PATCH",
                acceptanceTargetRef: resolved.acceptanceTargetRef,
            },
        },
    };
}
function scopeFinding(capture, declaration, declarationIdentitySha256) {
    const claimId = `v1-scope-${hashV1Value({
        contractVersion: V1_ACCEPTANCE_CONTRACT_VERSION,
        declarationIdentitySha256,
        baseCommit: capture.resolved.baseCommit,
        headCommit: capture.resolved.headCommit,
        finalNetPatchSha256: capture.finalNetPatch.sha256,
    })}`;
    return adjudicateClaimedScope(observeClaimedScope({
        claim: {
            kind: "EXACT_PATH_SET",
            claimedPaths: declaration.changeScope.paths,
        },
        claimContext: {
            claimId,
            exactClaimText: SCOPE_CLAIM_TEXT,
            normalizedClaimText: SCOPE_CLAIM_TEXT.toLowerCase(),
            claimFamily: "CF-003",
        },
        actualChangeSet: portableChangeSet(capture),
    }));
}
function evaluateChecks(declaration, trustedConfiguredChecks, loadedEvidence) {
    const issues = [];
    const declaredChecks = declaration?.checkResults ?? [];
    const configuredChecks = [...trustedConfiguredChecks].sort((left, right) => compareCanonicalStrings(left.checkId, right.checkId) ||
        compareCanonicalStrings(left.kind, right.kind));
    const configuredById = new Map(configuredChecks.map((configured) => [configured.checkId, configured]));
    const declaredById = new Map(declaredChecks.map((declared) => [declared.checkId, declared]));
    const evaluations = new Map();
    // Bind the declaration to the trusted configured set before matching any
    // evidence so coverage defects receive truthful, stable diagnostics.
    for (const declared of declaredChecks) {
        const configured = configuredById.get(declared.checkId);
        if (configured === undefined) {
            issues.push(issue(`declared_check_not_configured:${declared.checkId}`, "REVIEW_REQUIRED", `Declared ${declared.kind} check ${declared.checkId} is not present in the trusted evaluated-base configuration.`));
            evaluations.set(declared.checkId, {
                ...declared,
                establishedState: "INDETERMINATE",
                qualifyingEvidenceIdentities: [],
            });
        }
        else if (configured.kind !== declared.kind) {
            issues.push(issue(`declared_check_kind_mismatch:${declared.checkId}`, "REVIEW_REQUIRED", `Declared check ${declared.checkId} uses kind ${declared.kind}, but the trusted evaluated-base configuration requires ${configured.kind}.`));
            evaluations.set(declared.checkId, {
                ...declared,
                establishedState: "INDETERMINATE",
                qualifyingEvidenceIdentities: [],
            });
        }
    }
    for (const configured of configuredChecks) {
        const declared = declaredById.get(configured.checkId);
        const matching = loadedEvidence.filter((loaded) => loaded.evidence?.checkId === configured.checkId &&
            loaded.evidence.kind === configured.kind);
        const failures = matching.filter((loaded) => loaded.observation.state === "QUALIFYING_FAIL");
        const passes = matching.filter((loaded) => loaded.observation.state === "QUALIFYING_PASS");
        const qualifyingEvidenceIdentities = [...failures, ...passes]
            .flatMap((loaded) => loaded.observation.evidenceIdentitySha256 === null
            ? []
            : [loaded.observation.evidenceIdentitySha256])
            .sort(compareCanonicalStrings);
        if (failures.length > 0) {
            issues.push(issue(`required_check_failed:${configured.checkId}`, "BLOCKED", `Trusted ${configured.kind} evidence established that required configured check ${configured.checkId} failed.`));
            if (declared !== undefined && declared.kind === configured.kind) {
                evaluations.set(declared.checkId, {
                    ...declared,
                    establishedState: "FAIL_CONTRADICTION",
                    qualifyingEvidenceIdentities,
                });
            }
            continue;
        }
        if (declared === undefined) {
            issues.push(issue(`required_check_not_declared:${configured.checkId}`, "REVIEW_REQUIRED", `Required configured ${configured.kind} check ${configured.checkId} was not declared.`));
            continue;
        }
        if (declared.kind !== configured.kind) {
            continue;
        }
        if (passes.length > 0) {
            evaluations.set(declared.checkId, {
                ...declared,
                establishedState: "PASS_ESTABLISHED",
                qualifyingEvidenceIdentities,
            });
            continue;
        }
        issues.push(issue(`required_check_evidence_missing:${declared.checkId}`, "REVIEW_REQUIRED", `Qualifying state-bound trusted evidence was absent for required ${declared.kind} check ${declared.checkId}.`));
        evaluations.set(declared.checkId, {
            ...declared,
            establishedState: "INDETERMINATE",
            qualifyingEvidenceIdentities: [],
        });
    }
    const checks = declaredChecks.map((declared) => evaluations.get(declared.checkId) ?? {
        ...declared,
        establishedState: "INDETERMINATE",
        qualifyingEvidenceIdentities: [],
    });
    return { checks, issues };
}
function statusFor(issues) {
    return issues.some((candidate) => candidate.status === "BLOCKED")
        ? "BLOCKED"
        : issues.length > 0
            ? "REVIEW_REQUIRED"
            : "ACCEPTED";
}
function issueCheckIds(issues, prefix) {
    return issues
        .flatMap((candidate) => candidate.code.startsWith(prefix)
        ? [candidate.code.slice(prefix.length)]
        : [])
        .sort(compareCanonicalStrings);
}
function checkList(checkIds) {
    return checkIds.map((checkId) => `\`${checkId}\``).join(", ");
}
function requiredAction(status, issues) {
    if (status === "ACCEPTED") {
        return [
            "No ET repair action is required; human or branch policy retains merge authority.",
        ];
    }
    const actions = [];
    const failed = issueCheckIds(issues, "required_check_failed:");
    const omitted = issueCheckIds(issues, "required_check_not_declared:");
    const extra = issueCheckIds(issues, "declared_check_not_configured:");
    const mismatched = issueCheckIds(issues, "declared_check_kind_mismatch:");
    if (failed.length > 0) {
        actions.push(`Repair required configured check(s) ${checkList(failed)}, produce fresh qualifying PASS evidence, ensure the declaration covers the complete configured check set, and rerun ET.`);
    }
    if (omitted.length > 0) {
        actions.push(`Declare required configured check(s) ${checkList(omitted)} with their configured kind and rerun ET.`);
    }
    if (extra.length > 0) {
        actions.push(`Remove declaration entries for unconfigured check(s) ${checkList(extra)} and rerun ET.`);
    }
    if (mismatched.length > 0) {
        actions.push(`Correct the declared kind for configured check(s) ${checkList(mismatched)} and rerun ET.`);
    }
    if (actions.length > 0) {
        return actions;
    }
    if (status === "BLOCKED") {
        return [
            "Repair the contradicted declaration or evaluated state, produce fresh trusted evidence, and rerun ET.",
        ];
    }
    return [
        "Supply or repair the missing, stale, malformed, unbound, or policy-reviewed component and rerun ET.",
    ];
}
export function serializeV1AcceptanceResult(result) {
    return canonicalV1Json(result);
}
/**
 * Captures every repository-derived evaluator input before untrusted configured
 * checks execute. The GitHub adapter retains this object only in trusted memory.
 */
export async function prepareV1Acceptance(input) {
    const capture = await captureGitState({
        repositoryPath: input.repositoryPath,
        baseRef: input.baseRef,
        headRef: input.headRef,
        acceptanceTargetKind: "FINAL_NET_PR_PATCH",
    });
    const resolvedRepositoryPath = capture.repository.resolvedPath;
    const baseCommit = capture.resolved.baseCommit;
    const headCommit = capture.resolved.headCommit;
    const declarationLoad = resolvedRepositoryPath !== null && baseCommit !== null && headCommit !== null
        ? await loadV1AcceptanceDeclarationFromHead({
            repositoryPath: resolvedRepositoryPath,
            baseCommit,
            headCommit,
        })
        : unavailableDeclarationLoad();
    const loadedExternalEvidence = resolvedRepositoryPath !== null && headCommit !== null
        ? await loadV1CheckEvidence({
            repositoryPath: resolvedRepositoryPath,
            evidencePaths: input.evidencePaths ?? [],
            evaluatedHeadCommit: headCommit,
        })
        : [];
    return { capture, declarationLoad, loadedExternalEvidence };
}
/**
 * Pure evaluation over a trusted pre-check snapshot plus trusted parent-process
 * observations. It performs no repository or evidence-path reads.
 */
export function evaluatePreparedV1Acceptance(options) {
    const { capture, declarationLoad } = options.preparedState;
    const portableGitEvidenceIdentitySha256 = hashPortableGitEvidence(capture);
    const issues = [];
    if (capture.captureStatus !== "COMPLETE") {
        issues.push(issue("evaluated_git_state_incomplete", "REVIEW_REQUIRED", "The exact evaluated base, head, changed paths, and final net patch could not be captured completely."));
    }
    issues.push(...declarationLoad.issues);
    const baseCommit = capture.resolved.baseCommit;
    const headCommit = capture.resolved.headCommit;
    const declaration = declarationLoad.declaration;
    const declarationIdentitySha256 = declarationLoad.headBlobGitObjectId === null ||
        declarationLoad.headBlobSha256 === null
        ? null
        : hashV1Value({
            contractVersion: V1_ACCEPTANCE_CONTRACT_VERSION,
            declarationBlobGitObjectId: declarationLoad.headBlobGitObjectId,
            declarationBlobSha256: declarationLoad.headBlobSha256,
            declaration,
        });
    if (declaration !== null &&
        baseCommit !== null &&
        declaration.baseCommit !== baseCommit) {
        issues.push(issue("acceptance_declaration_base_mismatch", "REVIEW_REQUIRED", "The declared base commit did not match the exact evaluated base commit."));
    }
    if (declaration !== null && declarationLoad.changedFromBase !== true) {
        issues.push(issue("acceptance_declaration_not_changed", "REVIEW_REQUIRED", "The acceptance declaration was not changed from the evaluated base and therefore was not fresh for this state."));
    }
    const declarationIncludesItself = declaration?.changeScope.paths.includes(V1_ACCEPTANCE_DECLARATION_PATH) ?? false;
    const actualIncludesDeclaration = capture.changedPaths.includes(V1_ACCEPTANCE_DECLARATION_PATH);
    const declarationFreshEnoughForScopeComparison = declaration !== null &&
        baseCommit !== null &&
        declaration.baseCommit === baseCommit &&
        declarationLoad.changedFromBase === true &&
        actualIncludesDeclaration;
    if (declaration !== null && !declarationIncludesItself) {
        issues.push(issue("acceptance_declaration_self_inclusion_violation", declarationFreshEnoughForScopeComparison
            ? "BLOCKED"
            : "REVIEW_REQUIRED", "The V1 declaration must include .et-verify/acceptance.json in its own complete changed-path set."));
    }
    if (declaration !== null && !actualIncludesDeclaration) {
        issues.push(issue("acceptance_declaration_not_in_final_patch", "REVIEW_REQUIRED", "The declaration path was not changed in the evaluated final net patch, so declaration freshness was not established."));
    }
    let finding = null;
    let scopeState = "INDETERMINATE";
    if (declaration !== null &&
        declarationIdentitySha256 !== null &&
        declarationFreshEnoughForScopeComparison) {
        finding = scopeFinding(capture, declaration, declarationIdentitySha256);
        scopeState =
            finding.consequence === "ACCEPT"
                ? "MATCH"
                : finding.consequence === "REPAIR_REQUIRED"
                    ? "MISMATCH"
                    : "INDETERMINATE";
        if (scopeState === "MISMATCH") {
            issues.push(issue("acceptance_exact_path_set_mismatch", "BLOCKED", "The committed complete changed-path declaration contradicted the exact final changed-path set."));
        }
        else if (scopeState === "INDETERMINATE") {
            issues.push(issue("acceptance_exact_path_set_indeterminate", "REVIEW_REQUIRED", "The complete changed-path declaration could not be compared deterministically."));
        }
    }
    const trustedEvidence = headCommit === null
        ? []
        : evaluateTrustedCheckEvidence({
            evidence: options.trustedCheckEvidence ?? [],
            evaluatedHeadCommit: headCommit,
        });
    const loadedEvidence = [
        ...options.preparedState.loadedExternalEvidence,
        ...trustedEvidence,
    ].sort((left, right) => compareCanonicalStrings(canonicalV1Json(left.observation), canonicalV1Json(right.observation)));
    issues.push(...loadedEvidence.flatMap((loaded) => loaded.issues));
    const trustedConfiguredChecksAvailable = options.trustedConfiguredChecks.length > 0;
    const checkEvaluation = !trustedConfiguredChecksAvailable
        ? {
            checks: (declaration?.checkResults ?? []).map((declared) => ({
                ...declared,
                establishedState: "INDETERMINATE",
                qualifyingEvidenceIdentities: [],
            })),
            issues: [],
        }
        : evaluateChecks(declaration, options.trustedConfiguredChecks, loadedEvidence);
    issues.push(...checkEvaluation.issues);
    if (!trustedConfiguredChecksAvailable) {
        issues.push(issue("trusted_check_configuration_unavailable", "REVIEW_REQUIRED", "The authoritative trusted configured check set was unavailable, so acceptance could not be established."));
    }
    const trustBaseReviewRequired = options.trustBaseReview?.required === true;
    if (trustBaseReviewRequired) {
        const suppliedReasonCode = options.trustBaseReview.reasonCode;
        const reasonCode = /^[a-z0-9][a-z0-9_.-]{0,127}$/.test(suppliedReasonCode)
            ? suppliedReasonCode
            : "unspecified_trust_base_change";
        issues.push(issue(`trust_base_review_required:${reasonCode}`, "REVIEW_REQUIRED", "The evidence-producing trust base changed and policy requires human review."));
    }
    for (const review of options.integrationReviewIssues ?? []) {
        const reasonCode = /^[A-Z][A-Z0-9_]{0,127}$/.test(review.reasonCode)
            ? review.reasonCode.toLowerCase()
            : "unspecified_integration_uncertainty";
        const summary = typeof review.summary === "string" && review.summary.length > 0
            ? review.summary.slice(0, 512)
            : "The trusted integration could not establish a required observation.";
        issues.push(issue(`integration_review_required:${reasonCode}`, "REVIEW_REQUIRED", summary));
    }
    const stateBinding = {
        evaluatedBaseCommit: baseCommit,
        evaluatedHeadCommit: headCommit,
        declarationBlobGitObjectId: declarationLoad.headBlobGitObjectId,
        declarationBlobSha256: declarationLoad.headBlobSha256,
        declaredBaseCommit: declaration?.baseCommit ?? null,
        finalNetPatchSha256: capture.finalNetPatch.sha256,
        declarationChangedFromBase: declarationLoad.changedFromBase,
        portableGitEvidenceIdentitySha256,
        bindingIdentitySha256: "",
    };
    stateBinding.bindingIdentitySha256 = hashV1Value({
        contractVersion: V1_ACCEPTANCE_CONTRACT_VERSION,
        evaluatedBaseCommit: stateBinding.evaluatedBaseCommit,
        evaluatedHeadCommit: stateBinding.evaluatedHeadCommit,
        declarationBlobGitObjectId: stateBinding.declarationBlobGitObjectId,
        declarationBlobSha256: stateBinding.declarationBlobSha256,
        declaredBaseCommit: stateBinding.declaredBaseCommit,
        finalNetPatchSha256: stateBinding.finalNetPatchSha256,
        declarationChangedFromBase: stateBinding.declarationChangedFromBase,
        portableGitEvidenceIdentitySha256,
    });
    const bindingState = declaration !== null &&
        baseCommit !== null &&
        declaration.baseCommit === baseCommit &&
        declarationLoad.changedFromBase === true &&
        declarationIncludesItself &&
        actualIncludesDeclaration
        ? "BOUND"
        : declarationLoad.state === "VALID"
            ? "UNBOUND"
            : "INDETERMINATE";
    const finalIssues = uniqueIssues(issues);
    const status = statusFor(finalIssues);
    const reason = status === "ACCEPTED"
        ? "Every required V1 declaration was established for the exact state by qualifying trusted evidence."
        : finalIssues[0]?.summary ??
            "A required V1 acceptance component remained indeterminate.";
    const resultWithoutResultIdentity = {
        contractVersion: V1_ACCEPTANCE_CONTRACT_VERSION,
        status,
        reason,
        agentClaimed: { declaration },
        etEstablished: {
            declarationState: declarationLoad.state,
            stateBinding: bindingState,
            scopeState,
            scopeFinding: finding,
            checks: checkEvaluation.checks,
            trustBaseReviewRequired,
        },
        requiredHumanAction: requiredAction(status, finalIssues),
        supportingEvidence: loadedEvidence.map((loaded) => loaded.observation),
        issues: finalIssues,
        identity: {
            ...stateBinding,
            declarationIdentitySha256,
        },
        limitations: [
            "ET establishes only that every check in the complete trusted evaluated-base configuration was declared with the exact configured identity and produced the recorded result for the bound evaluated head under the trusted Action execution path.",
            "ET does not establish code correctness, test sufficiency, coverage adequacy, dependency safety, security, or absence of weakened tests or malicious changes.",
            "Human and branch policy retain consequence authority.",
        ],
    };
    const resultIdentitySha256 = hashV1Value(resultWithoutResultIdentity);
    return {
        ...resultWithoutResultIdentity,
        identity: {
            ...resultWithoutResultIdentity.identity,
            resultIdentitySha256,
        },
    };
}
export async function evaluateV1Acceptance(options) {
    const preparedState = await prepareV1Acceptance({
        repositoryPath: options.repositoryPath,
        baseRef: options.baseRef,
        headRef: options.headRef,
        ...(options.evidencePaths === undefined
            ? {}
            : { evidencePaths: options.evidencePaths }),
    });
    return evaluatePreparedV1Acceptance({
        preparedState,
        trustedConfiguredChecks: options.trustedConfiguredChecks,
        ...(options.trustedCheckEvidence === undefined
            ? {}
            : { trustedCheckEvidence: options.trustedCheckEvidence }),
        ...(options.trustBaseReview === undefined
            ? {}
            : { trustBaseReview: options.trustBaseReview }),
        ...(options.integrationReviewIssues === undefined
            ? {}
            : { integrationReviewIssues: options.integrationReviewIssues }),
    });
}
//# sourceMappingURL=evaluate-acceptance.js.map