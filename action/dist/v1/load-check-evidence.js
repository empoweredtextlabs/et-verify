import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { compareCanonicalStrings } from "../canonical-order.js";
import { canonicalV1Json, hashV1Value } from "./canonicalize.js";
import { V1_ACCEPTANCE_CONTRACT_VERSION } from "./types.js";
const SHA256 = /^[0-9a-f]{64}$/;
const CHECK_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value, keys) {
    const actual = Object.keys(value).sort(compareCanonicalStrings);
    const expected = [...keys].sort(compareCanonicalStrings);
    return (actual.length === expected.length &&
        actual.every((key, index) => key === expected[index]));
}
function portableIdentity(value) {
    return (typeof value === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/.test(value));
}
function issue(code, summary) {
    return { code, status: "REVIEW_REQUIRED", summary };
}
function within(root, candidate) {
    const delta = relative(root, candidate);
    return (delta === "" ||
        (!isAbsolute(delta) && delta !== ".." && !delta.startsWith(`..${sep}`)));
}
function rejected(state, issue_, artifactSha256 = null) {
    return {
        evidence: null,
        observation: {
            artifactSha256,
            evidenceIdentitySha256: null,
            recordedEvidence: null,
            checkId: null,
            kind: null,
            state,
            issueCodes: [issue_.code],
        },
        issues: [issue_],
    };
}
function validateEvidence(parsed, expectedSource) {
    if (!isRecord(parsed) ||
        !exactKeys(parsed, [
            "schemaVersion",
            "evidenceType",
            "source",
            "checkId",
            "kind",
            "commandIdentity",
            "configSha256",
            "headCommit",
            "result",
            "exitCode",
            "complete",
            "producerIdentity",
            "runIdentity",
            "output",
        ]) ||
        parsed.schemaVersion !== 1 ||
        parsed.evidenceType !== "CHECK_RESULT" ||
        parsed.source !== expectedSource ||
        typeof parsed.checkId !== "string" ||
        !CHECK_ID.test(parsed.checkId) ||
        (parsed.kind !== "TEST" && parsed.kind !== "BUILD") ||
        !portableIdentity(parsed.commandIdentity) ||
        typeof parsed.configSha256 !== "string" ||
        !SHA256.test(parsed.configSha256) ||
        typeof parsed.headCommit !== "string" ||
        !/^[0-9a-f]{40}$/.test(parsed.headCommit) ||
        (parsed.result !== "PASS" && parsed.result !== "FAIL") ||
        !Number.isSafeInteger(parsed.exitCode) ||
        parsed.exitCode < 0 ||
        parsed.exitCode > 255 ||
        parsed.complete !== true ||
        !portableIdentity(parsed.producerIdentity) ||
        !portableIdentity(parsed.runIdentity) ||
        !isRecord(parsed.output) ||
        !exactKeys(parsed.output, ["stdoutSha256", "stderrSha256"]) ||
        typeof parsed.output.stdoutSha256 !== "string" ||
        !SHA256.test(parsed.output.stdoutSha256) ||
        typeof parsed.output.stderrSha256 !== "string" ||
        !SHA256.test(parsed.output.stderrSha256) ||
        (parsed.result === "PASS" ? parsed.exitCode !== 0 : parsed.exitCode === 0)) {
        return null;
    }
    const common = {
        schemaVersion: 1,
        evidenceType: "CHECK_RESULT",
        checkId: parsed.checkId,
        kind: parsed.kind,
        commandIdentity: parsed.commandIdentity,
        configSha256: parsed.configSha256,
        headCommit: parsed.headCommit,
        result: parsed.result,
        exitCode: parsed.exitCode,
        complete: true,
        producerIdentity: parsed.producerIdentity,
        runIdentity: parsed.runIdentity,
        output: {
            stdoutSha256: parsed.output.stdoutSha256,
            stderrSha256: parsed.output.stderrSha256,
        },
    };
    return expectedSource === "CI_LOCAL_ARTIFACT"
        ? { ...common, source: "CI_LOCAL_ARTIFACT" }
        : {
            ...common,
            source: "TRUSTED_ACTION_PROCESS",
        };
}
function parseEvidence(bytes) {
    let parsed;
    try {
        parsed = JSON.parse(UTF8.decode(bytes));
    }
    catch {
        return null;
    }
    const evidence = validateEvidence(parsed, "CI_LOCAL_ARTIFACT");
    return evidence?.source === "CI_LOCAL_ARTIFACT" ? evidence : null;
}
async function loadOne(input) {
    const repositoryPath = resolve(input.repositoryPath);
    const requestedEvidencePath = resolve(input.evidencePath);
    if (within(repositoryPath, requestedEvidencePath)) {
        return rejected("REPOSITORY_RESIDENT_REJECTED", issue("check_evidence_repository_resident", "Repository-resident content cannot qualify as trusted CI-local TEST/BUILD evidence."));
    }
    let resolvedRepositoryPath;
    let resolvedEvidencePath;
    try {
        [resolvedRepositoryPath, resolvedEvidencePath] = await Promise.all([
            realpath(repositoryPath),
            realpath(requestedEvidencePath),
        ]);
    }
    catch {
        return rejected("MALFORMED_OR_UNREADABLE", issue("check_evidence_unreadable", "A supplied CI-local check evidence artifact could not be resolved or read."));
    }
    if (within(resolvedRepositoryPath, resolvedEvidencePath)) {
        return rejected("REPOSITORY_RESIDENT_REJECTED", issue("check_evidence_repository_resident", "Repository-resident content cannot qualify as trusted CI-local TEST/BUILD evidence."));
    }
    let bytes;
    try {
        const details = await stat(resolvedEvidencePath);
        if (!details.isFile() || details.size > MAX_EVIDENCE_BYTES) {
            return rejected("MALFORMED_OR_UNREADABLE", issue("check_evidence_unreadable", "A supplied CI-local artifact was not a regular file within the bounded V1 size limit."));
        }
        bytes = await readFile(resolvedEvidencePath);
    }
    catch {
        return rejected("MALFORMED_OR_UNREADABLE", issue("check_evidence_unreadable", "A supplied CI-local check evidence artifact could not be resolved or read."));
    }
    const artifactSha256 = createHash("sha256").update(bytes).digest("hex");
    const evidence = parseEvidence(bytes);
    if (evidence === null) {
        return rejected("MALFORMED_OR_UNREADABLE", issue("check_evidence_schema_invalid", "A supplied CI-local artifact did not satisfy the bounded V1 CHECK_RESULT schema."), artifactSha256);
    }
    const evidenceIdentitySha256 = hashV1Value({
        contractVersion: V1_ACCEPTANCE_CONTRACT_VERSION,
        artifactSha256,
        evidence,
    });
    const stale = evidence.headCommit !== input.evaluatedHeadCommit;
    const staleIssue = issue("check_evidence_head_mismatch", "A supplied CI-local check result was stale or unbound to the evaluated head commit.");
    return {
        evidence,
        observation: {
            artifactSha256,
            evidenceIdentitySha256,
            recordedEvidence: evidence,
            checkId: evidence.checkId,
            kind: evidence.kind,
            state: stale
                ? "STALE_OR_UNBOUND"
                : evidence.result === "PASS"
                    ? "QUALIFYING_PASS"
                    : "QUALIFYING_FAIL",
            issueCodes: stale ? [staleIssue.code] : [],
        },
        issues: stale ? [staleIssue] : [],
    };
}
export async function loadV1CheckEvidence(input) {
    const loaded = await Promise.all(input.evidencePaths.map((evidencePath) => loadOne({
        repositoryPath: input.repositoryPath,
        evidencePath,
        evaluatedHeadCommit: input.evaluatedHeadCommit,
    })));
    return loaded.sort((left, right) => compareCanonicalStrings(canonicalV1Json(left.observation), canonicalV1Json(right.observation)));
}
export function evaluateTrustedCheckEvidence(input) {
    return input.evidence
        .map((candidate) => {
        const evidence = validateEvidence(candidate, "TRUSTED_ACTION_PROCESS");
        if (evidence === null || evidence.source !== "TRUSTED_ACTION_PROCESS") {
            return rejected("MALFORMED_OR_UNREADABLE", issue("trusted_check_evidence_schema_invalid", "Trusted in-process check evidence did not satisfy the bounded V1 CHECK_RESULT schema."));
        }
        const evidenceIdentitySha256 = hashV1Value({
            contractVersion: V1_ACCEPTANCE_CONTRACT_VERSION,
            channel: "IN_PROCESS_TRUSTED_EVIDENCE",
            evidence,
        });
        const stale = evidence.headCommit !== input.evaluatedHeadCommit;
        const staleIssue = issue("check_evidence_head_mismatch", "A supplied trusted check result was stale or unbound to the evaluated head commit.");
        return {
            evidence,
            observation: {
                artifactSha256: null,
                evidenceIdentitySha256,
                recordedEvidence: evidence,
                checkId: evidence.checkId,
                kind: evidence.kind,
                state: stale
                    ? "STALE_OR_UNBOUND"
                    : evidence.result === "PASS"
                        ? "QUALIFYING_PASS"
                        : "QUALIFYING_FAIL",
                issueCodes: stale ? [staleIssue.code] : [],
            },
            issues: stale ? [staleIssue] : [],
        };
    })
        .sort((left, right) => compareCanonicalStrings(canonicalV1Json(left.observation), canonicalV1Json(right.observation)));
}
//# sourceMappingURL=load-check-evidence.js.map