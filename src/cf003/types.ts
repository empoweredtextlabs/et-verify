import type {
  OperationalConsequence,
  SemanticDecisiveFactBase,
  SemanticFinding,
  SemanticVerdict,
} from "../findings/types.js";
import type { ObservationState } from "../cf004/types.js";

export type Cf003ScopeClaim =
  | {
      kind: "EXACT_PATH_SET";
      claimedPaths: string[];
    }
  | {
      kind: "PATH_PREFIX_ONLY";
      allowedPrefixes: string[];
    }
  | {
      kind: "PROHIBITED_PATH_SCOPE";
      prohibitedPrefixes: string[];
      description: string;
    }
  | {
      kind: "DOCUMENTATION_ONLY";
      documentationPatterns?: string[];
    }
  | {
      kind: "TESTS_ONLY";
      testPatterns?: string[];
    }
  | {
      kind: "CHANGED_FILE_COUNT";
      claimedCount: number;
    };

export interface Cf003ClaimContext {
  claimId: string;
  exactClaimText: string;
  normalizedClaimText: string;
  claimFamily: "CF-003";
}

export interface Cf003ActualChangeSetSource {
  kind: "SUPPLIED_PATH_SET";
  label: string;
  evidence?: {
    kind: "GIT_DIFF_CAPTURE";
    captureIdentitySha256: string;
    baseCommit: string;
    headCommit: string;
    baseTree: string;
    headTree: string;
    acceptanceTargetKind:
      | "COMMIT"
      | "TREE"
      | "MERGE_RESULT"
      | "FINAL_NET_PR_PATCH";
    acceptanceTargetRef: string;
  };
}

export interface Cf003IncompleteGitChangeSetSource {
  kind: "GIT_CAPTURE_INCOMPLETE";
  label: string;
  limitationCode: "git_diff_capture_incomplete";
}

export interface Cf003ActualChangeSet {
  paths: string[];
  source: Cf003ActualChangeSetSource | Cf003IncompleteGitChangeSetSource;
}

export interface Cf003ObservationInput {
  claim: Cf003ScopeClaim;
  claimContext: Cf003ClaimContext;
  actualChangeSet: Cf003ActualChangeSet;
}

export type Cf003NormalizedScopeClaim =
  | {
      kind: "EXACT_PATH_SET";
      claimedPaths: string[];
    }
  | {
      kind: "PATH_PREFIX_ONLY";
      allowedPrefixes: string[];
    }
  | {
      kind: "PROHIBITED_PATH_SCOPE";
      prohibitedPrefixes: string[];
      description: string;
    }
  | {
      kind: "DOCUMENTATION_ONLY";
      documentationPatterns: string[];
      usesDefaultPatterns: boolean;
    }
  | {
      kind: "TESTS_ONLY";
      testPatterns: string[];
      usesDefaultPatterns: boolean;
    }
  | {
      kind: "CHANGED_FILE_COUNT";
      claimedCount: number;
    };

export interface Cf003ChangeSetCitation {
  citationId: string;
  source: Cf003ActualChangeSetSource;
  description: string;
  actualPath?: string;
  claimedPath?: string;
}

export interface Cf003ObservationLimitation {
  code:
    | "scope_path_input_invalid"
    | "scope_claim_input_invalid"
    | "scope_claim_context_invalid"
    | "scope_change_set_source_missing"
    | "git_diff_capture_incomplete";
  input: "scope_claim" | "claim_context" | "actual_change_set" | "change_set_source";
  message: string;
  path?: string;
}

interface Cf003MismatchBase {
  normalizedClaimType: Cf003NormalizedScopeClaim["kind"];
  mismatchReason: string;
  citation: Cf003ChangeSetCitation;
  statement: string;
}

export interface UndisclosedActualPathMismatch extends Cf003MismatchBase {
  kind: "UNDISCLOSED_ACTUAL_PATH";
  normalizedClaimType: "EXACT_PATH_SET";
  claimedOrAllowedScope: string[];
  actualPath: string;
}

export interface ClaimedButUnchangedPathMismatch extends Cf003MismatchBase {
  kind: "CLAIMED_BUT_UNCHANGED_PATH";
  normalizedClaimType: "EXACT_PATH_SET";
  claimedOrAllowedScope: string[];
  claimedPath: string;
}

export interface OutsideAllowedPrefixMismatch extends Cf003MismatchBase {
  kind: "OUTSIDE_ALLOWED_PREFIX";
  normalizedClaimType: "PATH_PREFIX_ONLY";
  claimedOrAllowedScope: string[];
  actualPath: string;
}

export interface ProhibitedPathMismatch extends Cf003MismatchBase {
  kind: "PROHIBITED_PATH";
  normalizedClaimType: "PROHIBITED_PATH_SCOPE";
  claimedOrAllowedScope: string[];
  actualPath: string;
  description: string;
}

export interface NonDocumentationPathMismatch extends Cf003MismatchBase {
  kind: "NON_DOCUMENTATION_PATH";
  normalizedClaimType: "DOCUMENTATION_ONLY";
  claimedOrAllowedScope: string[];
  actualPath: string;
}

export interface NonTestPathMismatch extends Cf003MismatchBase {
  kind: "NON_TEST_PATH";
  normalizedClaimType: "TESTS_ONLY";
  claimedOrAllowedScope: string[];
  actualPath: string;
}

export interface ChangedFileCountMismatch extends Cf003MismatchBase {
  kind: "CHANGED_FILE_COUNT_MISMATCH";
  normalizedClaimType: "CHANGED_FILE_COUNT";
  claimedOrAllowedScope: { claimedCount: number };
  claimedCount: number;
  actualCount: number;
}

export type Cf003ScopeMismatch =
  | UndisclosedActualPathMismatch
  | ClaimedButUnchangedPathMismatch
  | OutsideAllowedPrefixMismatch
  | ProhibitedPathMismatch
  | NonDocumentationPathMismatch
  | NonTestPathMismatch
  | ChangedFileCountMismatch;

export interface Cf003CountComparison {
  claimedCount: number;
  actualCount: number;
}

export interface Cf003ObservationResult {
  observationId: string;
  observationType: "CF-003_CLAIMED_SCOPE_REALITY";
  state: ObservationState;
  claimContext: Cf003ClaimContext;
  normalizedClaim: Cf003NormalizedScopeClaim | null;
  actualPaths: string[];
  changeSetSource: Cf003ActualChangeSetSource | null;
  mismatches: Cf003ScopeMismatch[];
  undisclosedActualPaths: string[];
  claimedButUnchangedPaths: string[];
  outOfScopeActualPaths: string[];
  prohibitedActualPaths: string[];
  nonDocumentationPaths: string[];
  nonTestPaths: string[];
  countComparison: Cf003CountComparison | null;
  citations: Cf003ChangeSetCitation[];
  limitations: Cf003ObservationLimitation[];
}

export interface Cf003MismatchDecisiveFact extends SemanticDecisiveFactBase {
  kind: "CLAIMED_SCOPE_MISMATCH";
  mismatch: Cf003ScopeMismatch;
}

export interface Cf003BoundedComparisonDecisiveFact
  extends SemanticDecisiveFactBase {
  kind: "CLAIMED_SCOPE_BOUNDED_COMPARISON";
  normalizedClaim: Cf003NormalizedScopeClaim;
  actualPaths: string[];
  citation: Cf003ChangeSetCitation;
  statement: string;
}

export interface Cf003IndeterminateDecisiveFact
  extends SemanticDecisiveFactBase {
  kind: "CLAIMED_SCOPE_INDETERMINATE_INPUTS";
  limitationCodes: string[];
  safelyNormalizedActualPaths: string[];
  statement: string;
}

export type Cf003DecisiveFact =
  | Cf003MismatchDecisiveFact
  | Cf003BoundedComparisonDecisiveFact
  | Cf003IndeterminateDecisiveFact;

export interface Cf003FindingMetadata {
  adjudicationMethod: "deterministic";
  mappingVersion: string;
  sourceObservationId: string;
  sourceObservationType: "CF-003_CLAIMED_SCOPE_REALITY";
  normalizedClaimType: Cf003NormalizedScopeClaim["kind"] | null;
  observationBinding: {
    claimId: string;
    changeSetSource: Cf003ActualChangeSetSource | null;
  };
}

export type Cf003SemanticFinding = SemanticFinding<
  "CLAIMED_SCOPE_REALITY",
  "CF-003",
  "claimed_scope_mismatch",
  Cf003DecisiveFact,
  Cf003FindingMetadata,
  Cf003ChangeSetCitation
> & {
  verdict: SemanticVerdict;
  consequence: OperationalConsequence;
};
