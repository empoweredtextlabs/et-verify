import type { Cf003SemanticFinding } from "../cf003/types.js";

export const V1_ACCEPTANCE_DECLARATION_PATH = ".et-verify/acceptance.json";
export const V1_ACCEPTANCE_CONTRACT_VERSION = "et-verify-v1-acceptance-1";

export type V1AcceptanceStatus = "ACCEPTED" | "REVIEW_REQUIRED" | "BLOCKED";
export type V1CheckKind = "TEST" | "BUILD";

export interface V1DeclaredCheckResult {
  checkId: string;
  kind: V1CheckKind;
  declaredResult: "PASS";
}

export interface V1TrustedConfiguredCheckIdentity {
  checkId: string;
  kind: V1CheckKind;
}

export interface V1AcceptanceDeclaration {
  schemaVersion: 1;
  baseCommit: string;
  /**
   * Complete final changed-path set. V1 requires the declaration blob to
   * change for the evaluated patch, so this set must include
   * `.et-verify/acceptance.json` itself. The evaluator enforces both facts.
   */
  changeScope: {
    kind: "EXACT_PATH_SET";
    paths: string[];
  };
  checkResults: V1DeclaredCheckResult[];
}

export interface V1CiLocalCheckEvidence {
  schemaVersion: 1;
  evidenceType: "CHECK_RESULT";
  source: "CI_LOCAL_ARTIFACT";
  checkId: string;
  kind: V1CheckKind;
  commandIdentity: string;
  configSha256: string;
  headCommit: string;
  result: "PASS" | "FAIL";
  exitCode: number;
  complete: true;
  producerIdentity: string;
  runIdentity: string;
  output: {
    stdoutSha256: string;
    stderrSha256: string;
  };
}

export interface V1TrustedActionCheckEvidence {
  schemaVersion: 1;
  evidenceType: "CHECK_RESULT";
  source: "TRUSTED_ACTION_PROCESS";
  checkId: string;
  kind: V1CheckKind;
  commandIdentity: string;
  configSha256: string;
  headCommit: string;
  result: "PASS" | "FAIL";
  exitCode: number;
  complete: true;
  producerIdentity: string;
  runIdentity: string;
  output: {
    stdoutSha256: string;
    stderrSha256: string;
  };
}

export type V1CheckEvidence =
  | V1CiLocalCheckEvidence
  | V1TrustedActionCheckEvidence;

export interface V1TrustBaseReview {
  required: true;
  reasonCode: string;
}

export interface EvaluateV1AcceptanceOptions {
  repositoryPath: string;
  baseRef: string;
  headRef: string;
  trustedConfiguredChecks: readonly V1TrustedConfiguredCheckIdentity[];
  evidencePaths?: string[];
  trustedCheckEvidence?: V1TrustedActionCheckEvidence[];
  trustBaseReview?: V1TrustBaseReview;
  integrationReviewIssues?: V1IntegrationReviewIssue[];
}

export interface V1IntegrationReviewIssue {
  reasonCode: string;
  summary: string;
}

export interface V1AcceptanceIssue {
  code: string;
  status: "REVIEW_REQUIRED" | "BLOCKED";
  summary: string;
}

export interface V1EvidenceObservation {
  artifactSha256: string | null;
  evidenceIdentitySha256: string | null;
  recordedEvidence: V1CheckEvidence | null;
  checkId: string | null;
  kind: V1CheckKind | null;
  state:
    | "QUALIFYING_PASS"
    | "QUALIFYING_FAIL"
    | "STALE_OR_UNBOUND"
    | "REPOSITORY_RESIDENT_REJECTED"
    | "MALFORMED_OR_UNREADABLE";
  issueCodes: string[];
}

export interface V1CheckEvaluation {
  checkId: string;
  kind: V1CheckKind;
  declaredResult: "PASS";
  establishedState:
    | "PASS_ESTABLISHED"
    | "FAIL_CONTRADICTION"
    | "INDETERMINATE";
  qualifyingEvidenceIdentities: string[];
}

export interface V1StateBinding {
  evaluatedBaseCommit: string | null;
  evaluatedHeadCommit: string | null;
  declarationBlobGitObjectId: string | null;
  declarationBlobSha256: string | null;
  declaredBaseCommit: string | null;
  finalNetPatchSha256: string | null;
  declarationChangedFromBase: boolean | null;
  portableGitEvidenceIdentitySha256: string;
  bindingIdentitySha256: string;
}

export interface V1AcceptanceResult {
  contractVersion: typeof V1_ACCEPTANCE_CONTRACT_VERSION;
  status: V1AcceptanceStatus;
  reason: string;
  agentClaimed: {
    declaration: V1AcceptanceDeclaration | null;
  };
  etEstablished: {
    declarationState: "VALID" | "MISSING" | "MALFORMED" | "UNAVAILABLE";
    stateBinding: "BOUND" | "UNBOUND" | "INDETERMINATE";
    scopeState: "MATCH" | "MISMATCH" | "INDETERMINATE";
    scopeFinding: Cf003SemanticFinding | null;
    checks: V1CheckEvaluation[];
    trustBaseReviewRequired: boolean;
  };
  requiredHumanAction: string[];
  supportingEvidence: V1EvidenceObservation[];
  issues: V1AcceptanceIssue[];
  identity: V1StateBinding & {
    declarationIdentitySha256: string | null;
    resultIdentitySha256: string;
  };
  limitations: string[];
}
