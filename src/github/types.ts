import type { V1AcceptanceResult, V1CheckKind, V1TrustedActionCheckEvidence } from "../v1/types.js";

export const V1_TRUSTED_CHECK_CONFIG_PATH = ".et-verify/checks.json";
export const GITHUB_ACTION_PRODUCER_IDENTITY = "et-verify-github-action-v1";
export const MERGE_QUEUE_SUPPORT = "MERGE_QUEUE_NOT_SUPPORTED_IN_V1_ALPHA";
export const RUNTIME_AUTHORITY_TOPOLOGY = "NOT_ESTABLISHED_BY_ACTION_RUN";
export const RECOMMENDED_PRODUCTION_TOPOLOGY =
  "ORGANIZATION_RULESET_REQUIRED_WORKFLOW";

export interface GitHubPullRequestIdentity {
  githubBaseTipSha: string;
  githubHeadSha: string;
  evaluatedBaseSha: string;
  evaluatedHeadSha: string;
  acceptanceTargetRef: string;
}

export type GitHubIdentityFailureCode =
  | "UNSUPPORTED_GITHUB_EVENT"
  | "GITHUB_EVENT_IDENTITY_INVALID"
  | "SYNTHETIC_MERGE_HEAD_REJECTED"
  | "CHECKED_OUT_HEAD_MISMATCH"
  | "MERGE_BASE_UNAVAILABLE";

export type GitHubIdentityResolution =
  | { ok: true; identity: GitHubPullRequestIdentity }
  | {
      ok: false;
      reasonCode: GitHubIdentityFailureCode;
      reason: string;
    };

export interface V1TrustedCheckDefinition {
  checkId: string;
  kind: V1CheckKind;
  command: string;
  args: string[];
  timeoutMs: number;
  commandIdentity: string;
}

export interface V1TrustedCheckConfiguration {
  schemaVersion: 1;
  checks: V1TrustedCheckDefinition[];
}

export type TrustedConfigLoadResult =
  | {
      ok: true;
      configuration: V1TrustedCheckConfiguration;
      configSha256: string;
      blobGitObjectId: string;
    }
  | {
      ok: false;
      reasonCode:
        | "TRUSTED_CHECK_CONFIG_UNAVAILABLE_AT_EVALUATED_BASE"
        | "TRUSTED_CHECK_CONFIG_INVALID";
      reason: string;
    };

export type TrustedCheckIndeterminateReason =
  | "SPAWN_FAILED"
  | "TIMED_OUT"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "ABNORMAL_TERMINATION";

export interface TrustedCheckExecution {
  checkId: string;
  kind: V1CheckKind;
  state: "PASS" | "FAIL" | "INDETERMINATE";
  evidence: V1TrustedActionCheckEvidence | null;
  indeterminateReason: TrustedCheckIndeterminateReason | null;
  stdoutBytes: number;
  stderrBytes: number;
}

export interface GitHubIntegrationResult {
  status: "ACCEPTED" | "REVIEW_REQUIRED" | "BLOCKED";
  reasonCode: string;
  reason: string;
  identity: GitHubPullRequestIdentity | null;
  configSha256: string | null;
  checks: TrustedCheckExecution[];
  evaluatorResult: V1AcceptanceResult | null;
  exitCode: 0 | 1;
  runtimeAuthorityTopology: typeof RUNTIME_AUTHORITY_TOPOLOGY;
  recommendedProductionTopology: typeof RECOMMENDED_PRODUCTION_TOPOLOGY;
  mergeQueueSupport: typeof MERGE_QUEUE_SUPPORT;
}

export interface GitHubIntegrationInput {
  repositoryPath: string;
  eventName: string;
  eventPayload: unknown;
  githubSha?: string;
  runIdentity: string;
}
