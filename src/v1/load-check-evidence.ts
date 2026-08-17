import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { compareCanonicalStrings } from "../canonical-order.js";
import { canonicalV1Json, hashV1Value } from "./canonicalize.js";
import type {
  V1AcceptanceIssue,
  V1CheckEvidence,
  V1CheckKind,
  V1CiLocalCheckEvidence,
  V1EvidenceObservation,
  V1TrustedActionCheckEvidence,
} from "./types.js";
import { V1_ACCEPTANCE_CONTRACT_VERSION } from "./types.js";

const SHA256 = /^[0-9a-f]{64}$/;
const CHECK_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

type UnknownRecord = Record<string, unknown>;

export interface V1LoadedEvidence {
  evidence: V1CheckEvidence | null;
  observation: V1EvidenceObservation;
  issues: V1AcceptanceIssue[];
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareCanonicalStrings);
  const expected = [...keys].sort(compareCanonicalStrings);
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function portableIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/.test(value)
  );
}

function issue(code: string, summary: string): V1AcceptanceIssue {
  return { code, status: "REVIEW_REQUIRED", summary };
}

function within(root: string, candidate: string): boolean {
  const delta = relative(root, candidate);
  return (
    delta === "" ||
    (!isAbsolute(delta) && delta !== ".." && !delta.startsWith(`..${sep}`))
  );
}

function rejected(
  state: V1EvidenceObservation["state"],
  issue_: V1AcceptanceIssue,
  artifactSha256: string | null = null,
): V1LoadedEvidence {
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

function validateEvidence(
  parsed: unknown,
  expectedSource: V1CheckEvidence["source"],
): V1CheckEvidence | null {
  if (
    !isRecord(parsed) ||
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
    (parsed.exitCode as number) < 0 ||
    (parsed.exitCode as number) > 255 ||
    parsed.complete !== true ||
    !portableIdentity(parsed.producerIdentity) ||
    !portableIdentity(parsed.runIdentity) ||
    !isRecord(parsed.output) ||
    !exactKeys(parsed.output, ["stdoutSha256", "stderrSha256"]) ||
    typeof parsed.output.stdoutSha256 !== "string" ||
    !SHA256.test(parsed.output.stdoutSha256) ||
    typeof parsed.output.stderrSha256 !== "string" ||
    !SHA256.test(parsed.output.stderrSha256) ||
    (parsed.result === "PASS" ? parsed.exitCode !== 0 : parsed.exitCode === 0)
  ) {
    return null;
  }
  const common = {
    schemaVersion: 1 as const,
    evidenceType: "CHECK_RESULT" as const,
    checkId: parsed.checkId,
    kind: parsed.kind as V1CheckKind,
    commandIdentity: parsed.commandIdentity,
    configSha256: parsed.configSha256,
    headCommit: parsed.headCommit,
    result: parsed.result as "PASS" | "FAIL",
    exitCode: parsed.exitCode as number,
    complete: true as const,
    producerIdentity: parsed.producerIdentity,
    runIdentity: parsed.runIdentity,
    output: {
      stdoutSha256: parsed.output.stdoutSha256,
      stderrSha256: parsed.output.stderrSha256,
    },
  };
  return expectedSource === "CI_LOCAL_ARTIFACT"
    ? ({ ...common, source: "CI_LOCAL_ARTIFACT" } satisfies V1CiLocalCheckEvidence)
    : ({
        ...common,
        source: "TRUSTED_ACTION_PROCESS",
      } satisfies V1TrustedActionCheckEvidence);
}

function parseEvidence(bytes: Buffer): V1CiLocalCheckEvidence | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8.decode(bytes));
  } catch {
    return null;
  }
  const evidence = validateEvidence(parsed, "CI_LOCAL_ARTIFACT");
  return evidence?.source === "CI_LOCAL_ARTIFACT" ? evidence : null;
}

async function loadOne(input: {
  repositoryPath: string;
  evidencePath: string;
  evaluatedHeadCommit: string;
}): Promise<V1LoadedEvidence> {
  const repositoryPath = resolve(input.repositoryPath);
  const requestedEvidencePath = resolve(input.evidencePath);
  if (within(repositoryPath, requestedEvidencePath)) {
    return rejected(
      "REPOSITORY_RESIDENT_REJECTED",
      issue(
        "check_evidence_repository_resident",
        "Repository-resident content cannot qualify as trusted CI-local TEST/BUILD evidence.",
      ),
    );
  }

  let resolvedRepositoryPath: string;
  let resolvedEvidencePath: string;
  try {
    [resolvedRepositoryPath, resolvedEvidencePath] = await Promise.all([
      realpath(repositoryPath),
      realpath(requestedEvidencePath),
    ]);
  } catch {
    return rejected(
      "MALFORMED_OR_UNREADABLE",
      issue(
        "check_evidence_unreadable",
        "A supplied CI-local check evidence artifact could not be resolved or read.",
      ),
    );
  }
  if (within(resolvedRepositoryPath, resolvedEvidencePath)) {
    return rejected(
      "REPOSITORY_RESIDENT_REJECTED",
      issue(
        "check_evidence_repository_resident",
        "Repository-resident content cannot qualify as trusted CI-local TEST/BUILD evidence.",
      ),
    );
  }

  let bytes: Buffer;
  try {
    const details = await stat(resolvedEvidencePath);
    if (!details.isFile() || details.size > MAX_EVIDENCE_BYTES) {
      return rejected(
        "MALFORMED_OR_UNREADABLE",
        issue(
          "check_evidence_unreadable",
          "A supplied CI-local artifact was not a regular file within the bounded V1 size limit.",
        ),
      );
    }
    bytes = await readFile(resolvedEvidencePath);
  } catch {
    return rejected(
      "MALFORMED_OR_UNREADABLE",
      issue(
        "check_evidence_unreadable",
        "A supplied CI-local check evidence artifact could not be resolved or read.",
      ),
    );
  }

  const artifactSha256 = createHash("sha256").update(bytes).digest("hex");
  const evidence = parseEvidence(bytes);
  if (evidence === null) {
    return rejected(
      "MALFORMED_OR_UNREADABLE",
      issue(
        "check_evidence_schema_invalid",
        "A supplied CI-local artifact did not satisfy the bounded V1 CHECK_RESULT schema.",
      ),
      artifactSha256,
    );
  }
  const evidenceIdentitySha256 = hashV1Value({
    contractVersion: V1_ACCEPTANCE_CONTRACT_VERSION,
    artifactSha256,
    evidence,
  });
  const stale = evidence.headCommit !== input.evaluatedHeadCommit;
  const staleIssue = issue(
    "check_evidence_head_mismatch",
    "A supplied CI-local check result was stale or unbound to the evaluated head commit.",
  );
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

export async function loadV1CheckEvidence(input: {
  repositoryPath: string;
  evidencePaths: readonly string[];
  evaluatedHeadCommit: string;
}): Promise<V1LoadedEvidence[]> {
  const loaded = await Promise.all(
    input.evidencePaths.map((evidencePath) =>
      loadOne({
        repositoryPath: input.repositoryPath,
        evidencePath,
        evaluatedHeadCommit: input.evaluatedHeadCommit,
      }),
    ),
  );
  return loaded.sort((left, right) =>
    compareCanonicalStrings(
      canonicalV1Json(left.observation),
      canonicalV1Json(right.observation),
    ),
  );
}

export function evaluateTrustedCheckEvidence(input: {
  evidence: readonly unknown[];
  evaluatedHeadCommit: string;
}): V1LoadedEvidence[] {
  return input.evidence
    .map((candidate): V1LoadedEvidence => {
      const evidence = validateEvidence(candidate, "TRUSTED_ACTION_PROCESS");
      if (evidence === null || evidence.source !== "TRUSTED_ACTION_PROCESS") {
        return rejected(
          "MALFORMED_OR_UNREADABLE",
          issue(
            "trusted_check_evidence_schema_invalid",
            "Trusted in-process check evidence did not satisfy the bounded V1 CHECK_RESULT schema.",
          ),
        );
      }
      const evidenceIdentitySha256 = hashV1Value({
        contractVersion: V1_ACCEPTANCE_CONTRACT_VERSION,
        channel: "IN_PROCESS_TRUSTED_EVIDENCE",
        evidence,
      });
      const stale = evidence.headCommit !== input.evaluatedHeadCommit;
      const staleIssue = issue(
        "check_evidence_head_mismatch",
        "A supplied trusted check result was stale or unbound to the evaluated head commit.",
      );
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
    .sort((left, right) =>
      compareCanonicalStrings(
        canonicalV1Json(left.observation),
        canonicalV1Json(right.observation),
      ),
    );
}
