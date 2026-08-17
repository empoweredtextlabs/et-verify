export type ObservationState =
  | "OBSERVED"
  | "NOT_OBSERVED"
  | "INDETERMINATE";

export type DependencyOperation =
  | "create"
  | "grant"
  | "reference"
  | "require";

export interface SourceLocator {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  excerpt: string;
  jsonPointer?: string;
}

export interface SourceArtifact {
  artifactId: string;
  relativePath: string;
  text: string;
  language?: string;
}

export interface TargetTopologyArtifact {
  artifactId: string;
  relativePath: string;
  declaredTopologyFormat: string;
  text?: string;
  parsedData?: unknown;
}

export interface ObservationBindingInput {
  kind: "repository" | "fixture" | "input";
  id?: string;
}

export interface Cf004ObservationInput {
  harnessSources: SourceArtifact[];
  workSources: SourceArtifact[];
  targetSnapshot?: TargetTopologyArtifact;
  binding?: ObservationBindingInput;
}

export interface DependencyRef {
  kind: "postgres_role";
  name: string;
  normalizedName: string;
  originalSpelling: string;
  sourceArtifactId: string;
  relativePath: string;
  locator: SourceLocator;
  operation: DependencyOperation;
}

export interface Citation {
  citationId: string;
  sourceArtifactId: string;
  relativePath: string;
  locator: SourceLocator;
  description: string;
}

export interface ExtractionLimitation {
  code: string;
  message: string;
  sourceArtifactId: string;
  relativePath: string;
  locator: SourceLocator;
}

export interface ExtractionResult {
  dependencies: DependencyRef[];
  limitations: ExtractionLimitation[];
}

export interface TargetTopologyReadResult extends ExtractionResult {
  authoritativeSetCitation?: Citation;
}

export interface MissingInput {
  input:
    | "harness_setup_source"
    | "work_source"
    | "target_snapshot";
  message: string;
}

export interface MatchedComparison {
  dependency: {
    kind: "postgres_role";
    name: string;
    normalizedName: string;
  };
  constructions: DependencyRef[];
  workReferences: DependencyRef[];
  targetPresent: boolean;
  targetMatches: DependencyRef[];
  targetSetCitation: Citation;
}

export interface ObservedDefect {
  dependency: {
    kind: "postgres_role";
    name: string;
    normalizedName: string;
  };
  construction: Citation;
  workReference: Citation;
  targetObservation: {
    present: false;
    citation: Citation;
  };
  statement: string;
}

export interface ObservationBindingMetadata {
  kind: "repository" | "fixture" | "input";
  id?: string;
  harnessArtifactIds: string[];
  workArtifactIds: string[];
  targetArtifactId?: string;
}

export interface Cf004ObservationResult {
  observationId: string;
  observationType: "CF-004_TARGET_ENVIRONMENT_PARITY";
  state: ObservationState;
  constructedDependencies: DependencyRef[];
  referencedDependencies: DependencyRef[];
  targetDependencies: DependencyRef[];
  matchedComparisons: MatchedComparison[];
  observedDefects: ObservedDefect[];
  missingInputs: MissingInput[];
  limitations: ExtractionLimitation[];
  citations: Citation[];
  binding: ObservationBindingMetadata;
}
