import type {
  Citation,
  ObservationBindingMetadata,
  ObservationState,
} from "../cf004/types.js";

export type SemanticVerdict =
  | "PARTIALLY_SUPPORTED"
  | "NO_MATERIAL_FINDING"
  | "HUMAN_JUDGMENT_REQUIRED";

export type OperationalConsequence =
  | "REPAIR_REQUIRED"
  | "ACCEPT"
  | "REVIEW_REQUIRED";

export interface FindingDependency {
  kind: "postgres_role";
  name: string;
  normalizedName: string;
}

export interface SemanticDecisiveFactBase {
  kind: string;
  factId: string;
}

export interface ObservedDefectDecisiveFact extends SemanticDecisiveFactBase {
  kind: "OBSERVED_DEFECT";
  dependency: FindingDependency;
  statement: string;
  harnessConstructionCitation: Citation;
  workReferenceCitation: Citation;
  targetAbsenceCitation: Citation;
}

export interface BoundedComparisonDecisiveFact extends SemanticDecisiveFactBase {
  kind: "BOUNDED_COMPARISON";
  checkedConstructedDependencies: FindingDependency[];
  checkedWorkReferences: FindingDependency[];
  targetTopologyAvailability: "AUTHORITATIVE";
  comparisonScope: string;
  citations: Citation[];
}

export interface IndeterminateDecisiveFact extends SemanticDecisiveFactBase {
  kind: "INDETERMINATE_INPUTS";
  missingInputs: string[];
  limitationCodes: string[];
  safelyExtracted: {
    constructedDependencies: FindingDependency[];
    referencedDependencies: FindingDependency[];
    targetDependencies: FindingDependency[];
  };
  citations: Citation[];
}

export type SemanticDecisiveFact =
  | ObservedDefectDecisiveFact
  | BoundedComparisonDecisiveFact
  | IndeterminateDecisiveFact;

export interface SemanticLimitation {
  code: string;
  message: string;
  citation?: Citation;
}

export interface SemanticFindingMetadata {
  adjudicationMethod: "deterministic";
  mappingVersion: string;
  sourceObservationId: string;
  sourceObservationType: string;
  observationBinding: ObservationBindingMetadata;
  claimSourceReference?: {
    artifactId: string;
    path: string;
    locator?: string;
  };
}

export interface SemanticFinding<
  FindingType extends string = string,
  ClaimFamily extends string = string,
  DefectId extends string = string,
  DecisiveFact extends SemanticDecisiveFactBase = SemanticDecisiveFact,
  Metadata extends object = SemanticFindingMetadata,
  FindingCitation extends object = Citation,
> {
  findingId: string;
  findingType: FindingType;
  claimId: string;
  exactClaimText: string;
  normalizedClaim: string;
  claimFamily: ClaimFamily;
  defectId: DefectId;
  observationState: ObservationState;
  verdict: SemanticVerdict;
  consequence: OperationalConsequence;
  summary: string;
  decisiveFacts: DecisiveFact[];
  citations: FindingCitation[];
  limitations: SemanticLimitation[];
  prohibitedConclusions: string[];
  requiredAction: string[];
  whatWouldChangeThis: string[];
  metadata: Metadata;
}
