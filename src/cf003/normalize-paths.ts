import { compareCanonicalStrings } from "../canonical-order.js";
import type { Cf003ObservationLimitation } from "./types.js";

export const DEFAULT_DOCUMENTATION_PATTERNS = [
  "docs/",
  "*.md",
  "*.mdx",
  "README",
  "README.*",
] as const;

export const DEFAULT_TEST_PATTERNS = [
  "test/",
  "tests/",
  "__tests__/",
  "*.test.*",
  "*.spec.*",
] as const;

export type PathInputSurface = "scope_claim" | "actual_change_set";

export type PathNormalizationResult =
  | { ok: true; path: string }
  | { ok: false; limitation: Cf003ObservationLimitation };

function invalidPath(
  surface: PathInputSurface,
  message: string,
  path?: string,
): PathNormalizationResult {
  return {
    ok: false,
    limitation: {
      code: "scope_path_input_invalid",
      input: surface,
      message,
      ...(path === undefined ? {} : { path }),
    },
  };
}

function slashNormalized(value: string): string {
  let normalized = value.replaceAll("\\", "/");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized.replace(/\/{2,}/g, "/");
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:(?:\/|$)/.test(value);
}

export function normalizeScopePath(
  value: unknown,
  surface: PathInputSurface,
): PathNormalizationResult {
  if (typeof value !== "string") {
    return invalidPath(surface, "A scope path was not a string.");
  }

  const normalized = slashNormalized(value);
  if (normalized.length === 0 || normalized === ".") {
    return invalidPath(surface, "A scope path was empty after normalization.", value);
  }
  if (isAbsolutePath(normalized)) {
    return invalidPath(surface, "Absolute scope paths are not admitted.", value);
  }
  if (normalized.split("/").includes("..")) {
    return invalidPath(surface, "Parent traversal segments are not admitted.", value);
  }
  return { ok: true, path: normalized };
}

export function normalizePathSet(
  value: unknown,
  surface: PathInputSurface,
): { paths: string[]; limitations: Cf003ObservationLimitation[] } {
  if (!Array.isArray(value)) {
    return {
      paths: [],
      limitations: [
        {
          code: "scope_path_input_invalid",
          input: surface,
          message: "The scope path collection was not an array.",
        },
      ],
    };
  }

  const paths = new Set<string>();
  const limitations: Cf003ObservationLimitation[] = [];
  for (const candidate of value) {
    const result = normalizeScopePath(candidate, surface);
    if (result.ok) {
      paths.add(result.path);
    } else {
      limitations.push(result.limitation);
    }
  }
  return {
    paths: [...paths].sort(compareCanonicalStrings),
    limitations,
  };
}

export function normalizePatternSet(value: unknown): {
  patterns: string[];
  limitations: Cf003ObservationLimitation[];
} {
  const normalized = normalizePathSet(value, "scope_claim");
  const patterns: string[] = [];
  const limitations = [...normalized.limitations];
  for (const pattern of normalized.paths) {
    if (/[?\[\]]/.test(pattern)) {
      limitations.push({
        code: "scope_path_input_invalid",
        input: "scope_claim",
        message: "Only literal paths and asterisk pattern tokens are admitted.",
        path: pattern,
      });
    } else {
      patterns.push(pattern);
    }
  }
  return { patterns, limitations };
}

export function pathMatchesPrefix(path: string, prefix: string): boolean {
  return prefix.endsWith("/")
    ? path.startsWith(prefix)
    : path === prefix || path.startsWith(`${prefix}/`);
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function pathMatchesPattern(path: string, pattern: string): boolean {
  if (pattern.endsWith("/") && !pattern.includes("*")) {
    const directory = pattern.slice(0, -1);
    if (directory.includes("/")) {
      return path.startsWith(pattern);
    }
    return path.split("/").slice(0, -1).includes(directory);
  }

  const target = pattern.includes("/") ? path : (path.split("/").at(-1) ?? path);
  const expression = pattern
    .split("*")
    .map(escapeRegularExpression)
    .join("[^/]*");
  return new RegExp(`^${expression}$`).test(target);
}

export function isDefaultDocumentationPath(path: string): boolean {
  const fileName = path.split("/").at(-1) ?? path;
  return (
    path.startsWith("docs/") ||
    fileName.endsWith(".md") ||
    fileName.endsWith(".mdx") ||
    fileName === "README" ||
    fileName.startsWith("README.")
  );
}

export function isDefaultTestPath(path: string): boolean {
  const parts = path.split("/");
  const fileName = parts.at(-1) ?? path;
  const directories = parts.slice(0, -1);
  return (
    directories.some((part) =>
      part === "test" || part === "tests" || part === "__tests__"
    ) ||
    fileName.includes(".test.") ||
    fileName.includes(".spec.")
  );
}
