import { createHash } from "node:crypto";

import { compareCanonicalStrings } from "../canonical-order.js";
import { normalizePathSet } from "../cf003/normalize-paths.js";
import { createGitReadonlyRunner } from "../git/run-git-readonly.js";
import type {
  V1AcceptanceDeclaration,
  V1AcceptanceIssue,
  V1CheckKind,
} from "./types.js";
import { V1_ACCEPTANCE_DECLARATION_PATH } from "./types.js";

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CHECK_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const MAX_DECLARATION_BYTES = 1024 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

type UnknownRecord = Record<string, unknown>;

export interface V1DeclarationLoadResult {
  state: "VALID" | "MISSING" | "MALFORMED" | "UNAVAILABLE";
  declaration: V1AcceptanceDeclaration | null;
  headBlobGitObjectId: string | null;
  headBlobSha256: string | null;
  headBlobBytes: number | null;
  baseBlobGitObjectId: string | null;
  changedFromBase: boolean | null;
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

function issue(code: string, summary: string): V1AcceptanceIssue {
  return { code, status: "REVIEW_REQUIRED", summary };
}

function parseDeclaration(bytes: Buffer): {
  declaration: V1AcceptanceDeclaration | null;
  issue: V1AcceptanceIssue | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8.decode(bytes));
  } catch {
    return {
      declaration: null,
      issue: issue(
        "acceptance_declaration_json_invalid",
        "The committed acceptance declaration was not valid UTF-8 JSON.",
      ),
    };
  }
  if (
    !isRecord(parsed) ||
    !exactKeys(parsed, ["schemaVersion", "baseCommit", "changeScope", "checkResults"]) ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.baseCommit !== "string" ||
    !/^[0-9a-f]{40}$/.test(parsed.baseCommit) ||
    !isRecord(parsed.changeScope) ||
    !exactKeys(parsed.changeScope, ["kind", "paths"]) ||
    parsed.changeScope.kind !== "EXACT_PATH_SET" ||
    !Array.isArray(parsed.changeScope.paths) ||
    !Array.isArray(parsed.checkResults) ||
    parsed.checkResults.length === 0
  ) {
    return {
      declaration: null,
      issue: issue(
        "acceptance_declaration_schema_invalid",
        "The committed acceptance declaration did not satisfy the bounded V1 schema.",
      ),
    };
  }

  const normalizedPaths = normalizePathSet(parsed.changeScope.paths, "scope_claim");
  if (
    normalizedPaths.limitations.length > 0 ||
    normalizedPaths.paths.length !== parsed.changeScope.paths.length
  ) {
    return {
      declaration: null,
      issue: issue(
        "acceptance_declaration_paths_invalid",
        "The complete changed-path declaration contained an invalid or duplicate normalized repository-relative path.",
      ),
    };
  }

  const checks: V1AcceptanceDeclaration["checkResults"] = [];
  const checkIds = new Set<string>();
  for (const candidate of parsed.checkResults) {
    if (
      !isRecord(candidate) ||
      !exactKeys(candidate, ["checkId", "kind", "declaredResult"]) ||
      typeof candidate.checkId !== "string" ||
      !CHECK_ID.test(candidate.checkId) ||
      (candidate.kind !== "TEST" && candidate.kind !== "BUILD") ||
      candidate.declaredResult !== "PASS" ||
      checkIds.has(candidate.checkId)
    ) {
      return {
        declaration: null,
        issue: issue(
          "acceptance_declaration_checks_invalid",
          "The declaration's required TEST/BUILD PASS checks were absent, duplicated, malformed, or unsupported.",
        ),
      };
    }
    checkIds.add(candidate.checkId);
    checks.push({
      checkId: candidate.checkId,
      kind: candidate.kind as V1CheckKind,
      declaredResult: "PASS",
    });
  }
  checks.sort(
    (left, right) =>
      compareCanonicalStrings(left.checkId, right.checkId) ||
      compareCanonicalStrings(left.kind, right.kind),
  );

  return {
    declaration: {
      schemaVersion: 1,
      baseCommit: parsed.baseCommit,
      changeScope: {
        kind: "EXACT_PATH_SET",
        paths: normalizedPaths.paths,
      },
      checkResults: checks,
    },
    issue: null,
  };
}

function parseTreeEntry(output: Buffer): {
  state: "PRESENT" | "MISSING" | "MALFORMED";
  objectId: string | null;
} {
  if (output.byteLength === 0) {
    return { state: "MISSING", objectId: null };
  }
  if (output[output.byteLength - 1] !== 0) {
    return { state: "MALFORMED", objectId: null };
  }
  let text: string;
  try {
    text = UTF8.decode(output.subarray(0, output.byteLength - 1));
  } catch {
    return { state: "MALFORMED", objectId: null };
  }
  if (text.includes("\0") || text.includes("\n") || text.includes("\r")) {
    return { state: "MALFORMED", objectId: null };
  }
  const match = text.match(
    /^(100644|100755) blob ([0-9a-f]{40}(?:[0-9a-f]{24})?)\t\.et-verify\/acceptance\.json$/,
  );
  return match === null
    ? { state: "MALFORMED", objectId: null }
    : { state: "PRESENT", objectId: match[2] ?? null };
}

export async function loadV1AcceptanceDeclarationFromHead(input: {
  repositoryPath: string;
  baseCommit: string;
  headCommit: string;
}): Promise<V1DeclarationLoadResult> {
  const runner = createGitReadonlyRunner();
  const [baseTree, headTree] = await Promise.all([
    runner.run(input.repositoryPath, [
      "ls-tree",
      "-z",
      "--full-tree",
      input.baseCommit,
      "--",
      V1_ACCEPTANCE_DECLARATION_PATH,
    ]),
    runner.run(input.repositoryPath, [
      "ls-tree",
      "-z",
      "--full-tree",
      input.headCommit,
      "--",
      V1_ACCEPTANCE_DECLARATION_PATH,
    ]),
  ]);
  if (!baseTree.ok || !headTree.ok) {
    return {
      state: "UNAVAILABLE",
      declaration: null,
      headBlobGitObjectId: null,
      headBlobSha256: null,
      headBlobBytes: null,
      baseBlobGitObjectId: null,
      changedFromBase: null,
      issues: [
        issue(
          "acceptance_declaration_git_read_failed",
          "The acceptance declaration could not be read safely from the evaluated Git commits.",
        ),
      ],
    };
  }

  const base = parseTreeEntry(baseTree.stdout);
  const head = parseTreeEntry(headTree.stdout);
  if (base.state === "MALFORMED" || head.state === "MALFORMED") {
    return {
      state: "UNAVAILABLE",
      declaration: null,
      headBlobGitObjectId: head.objectId,
      headBlobSha256: null,
      headBlobBytes: null,
      baseBlobGitObjectId: base.objectId,
      changedFromBase: null,
      issues: [
        issue(
          "acceptance_declaration_tree_entry_invalid",
          "The acceptance declaration tree entry was not a regular Git blob with the required repository-relative path.",
        ),
      ],
    };
  }
  if (head.state === "MISSING" || head.objectId === null) {
    return {
      state: "MISSING",
      declaration: null,
      headBlobGitObjectId: null,
      headBlobSha256: null,
      headBlobBytes: null,
      baseBlobGitObjectId: base.objectId,
      changedFromBase: base.state === "MISSING" ? null : false,
      issues: [
        issue(
          "acceptance_declaration_missing",
          "Required ET acceptance declaration was not present and state-bound; add or repair it and rerun.",
        ),
      ],
    };
  }
  if (!OBJECT_ID.test(head.objectId)) {
    throw new Error("Internal V1 declaration object validation failed.");
  }
  const blob = await runner.run(input.repositoryPath, [
    "cat-file",
    "blob",
    head.objectId,
  ]);
  if (!blob.ok || blob.stdout.byteLength > MAX_DECLARATION_BYTES) {
    return {
      state: "UNAVAILABLE",
      declaration: null,
      headBlobGitObjectId: head.objectId,
      headBlobSha256: null,
      headBlobBytes: null,
      baseBlobGitObjectId: base.objectId,
      changedFromBase: base.objectId !== head.objectId,
      issues: [
        issue(
          "acceptance_declaration_blob_unavailable",
          "The committed acceptance declaration blob could not be read within the bounded V1 size limit.",
        ),
      ],
    };
  }

  const blobSha256 = createHash("sha256").update(blob.stdout).digest("hex");
  if (!SHA256.test(blobSha256)) {
    throw new Error("Internal V1 declaration SHA-256 validation failed.");
  }
  const parsed = parseDeclaration(blob.stdout);
  return {
    state: parsed.declaration === null ? "MALFORMED" : "VALID",
    declaration: parsed.declaration,
    headBlobGitObjectId: head.objectId,
    headBlobSha256: blobSha256,
    headBlobBytes: blob.stdout.byteLength,
    baseBlobGitObjectId: base.objectId,
    changedFromBase: base.objectId !== head.objectId,
    issues: parsed.issue === null ? [] : [parsed.issue],
  };
}
