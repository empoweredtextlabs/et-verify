export const GIT_STATE_ADAPTER_VERSION = "1.0.0";

export type GitCaptureStatus = "COMPLETE" | "INCOMPLETE" | "FAILED";

export type GitAcceptanceTargetKind =
  | "COMMIT"
  | "TREE"
  | "MERGE_RESULT"
  | "FINAL_NET_PR_PATCH";

export interface GitStateCaptureRequest {
  repositoryPath: string;
  baseRef: string;
  headRef: string;
  acceptanceTargetKind: GitAcceptanceTargetKind;
}

export interface GitEvidenceIssue {
  code: string;
  message: string;
}

export interface GitStateCaptureResult {
  captureStatus: GitCaptureStatus;
  repository: {
    requestedPath: string;
    resolvedPath: string | null;
  };
  request: {
    baseRef: string;
    headRef: string;
    acceptanceTargetKind: GitAcceptanceTargetKind | null;
  };
  resolved: {
    baseCommit: string | null;
    headCommit: string | null;
    baseTree: string | null;
    headTree: string | null;
    acceptanceTargetRef: string | null;
  };
  changedPaths: string[];
  finalNetPatch: {
    available: boolean;
    sha256: string | null;
    bytes: number | null;
    text: string | null;
  };
  workingTree: {
    inspected: boolean;
    clean: boolean | null;
    entries: string[];
  };
  limitations: GitEvidenceIssue[];
  errors: GitEvidenceIssue[];
  metadata: {
    adapterVersion: string;
    capturedAtUtc: string;
  };
}

export interface CanonicalGitEvidence {
  adapterVersion: string;
  captureStatus: GitCaptureStatus;
  repository: GitStateCaptureResult["repository"];
  request: GitStateCaptureResult["request"];
  resolved: GitStateCaptureResult["resolved"];
  changedPaths: string[];
  finalNetPatch: GitStateCaptureResult["finalNetPatch"];
  workingTree: GitStateCaptureResult["workingTree"];
  limitations: GitEvidenceIssue[];
  errors: GitEvidenceIssue[];
}

export type GitPatchArtifactObservationKind =
  | "PATH_PRESENT_IN_PATCH"
  | "PATH_ABSENT_FROM_PATCH"
  | "TEXT_PRESENT_IN_PATCH"
  | "TEXT_ABSENT_FROM_PATCH";

export interface GitPatchArtifactObservationRequest {
  artifactKey: string;
  artifactLabel: string;
  observationKind: GitPatchArtifactObservationKind;
  value: string;
}

export interface GitPatchArtifactObservationResult {
  captureStatus: GitCaptureStatus;
  acceptanceTarget: {
    kind: "FINAL_NET_PR_PATCH";
    ref: string;
  } | null;
  artifact: {
    artifactKey: string;
    artifactLabel: string;
    state: "PRESENT" | "ABSENT" | null;
  };
  citation: {
    artifactId: string;
    path: string;
    locator?: string;
  } | null;
  limitations: GitEvidenceIssue[];
  errors: GitEvidenceIssue[];
}
