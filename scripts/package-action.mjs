import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const compiledRoot = join(repositoryRoot, "dist");
const packagedRoot = join(repositoryRoot, "action", "dist");
const actionEntrypoint = join(compiledRoot, "github", "action-entrypoint.js");

function isPathWithin(root, candidate) {
  const candidateRelativePath = relative(root, candidate);
  return (
    candidateRelativePath === "" ||
    (candidateRelativePath !== ".." &&
      !candidateRelativePath.startsWith(`..${sep}`) &&
      !isAbsolute(candidateRelativePath))
  );
}

function containmentError(message) {
  return new Error(`Action packaging containment error: ${message}`);
}

export function classifyImportSpecifier(specifier, importer = "<unknown>") {
  if (typeof specifier !== "string" || specifier.length === 0) {
    throw containmentError(`empty or invalid import specifier in ${importer}`);
  }
  if (specifier.startsWith("node:")) {
    if (!isBuiltin(specifier)) {
      throw containmentError(
        `unsupported node: import specifier ${JSON.stringify(specifier)} in ${importer}`,
      );
    }
    return "node-builtin";
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return "relative-local";
  }
  throw containmentError(
    `unsupported import specifier ${JSON.stringify(specifier)} in ${importer}`,
  );
}

async function createBuildBoundary(buildRoot) {
  const declaredRoot = resolve(buildRoot);
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(declaredRoot);
  } catch (error) {
    throw containmentError(
      `build root does not exist or cannot be resolved: ${declaredRoot}; ${error.message}`,
    );
  }
  const rootStatus = await stat(canonicalRoot);
  if (!rootStatus.isDirectory()) {
    throw containmentError(`build root is not a directory: ${declaredRoot}`);
  }
  return { declaredRoot, canonicalRoot };
}

async function resolveContainedFile(boundary, candidate, description) {
  const lexicalPath = resolve(candidate);
  if (!isPathWithin(boundary.declaredRoot, lexicalPath)) {
    throw containmentError(
      `${description} escapes the declared build root: ${lexicalPath}`,
    );
  }

  let canonicalPath;
  try {
    canonicalPath = await realpath(lexicalPath);
  } catch (error) {
    throw containmentError(
      `${description} does not exist or cannot be resolved: ${lexicalPath}; ${error.message}`,
    );
  }
  if (!isPathWithin(boundary.canonicalRoot, canonicalPath)) {
    throw containmentError(
      `${description} escapes the canonical build root through a symlink or reparse point: ${lexicalPath} -> ${canonicalPath}`,
    );
  }

  const fileStatus = await stat(canonicalPath);
  if (!fileStatus.isFile()) {
    throw containmentError(`${description} is not a regular file: ${lexicalPath}`);
  }
  return { lexicalPath, canonicalPath };
}

async function resolveCompiledDependency(boundary, importer, specifier) {
  const dependency = resolve(dirname(importer.lexicalPath), specifier);
  if (extname(dependency) !== ".js") {
    throw containmentError(
      `local import must resolve to an emitted .js file: ${JSON.stringify(specifier)} in ${importer.lexicalPath}`,
    );
  }
  return await resolveContainedFile(
    boundary,
    dependency,
    `compiled dependency ${JSON.stringify(specifier)} from ${importer.lexicalPath}`,
  );
}

async function collectRuntimeClosureRecords(options = {}) {
  const buildRoot = options.buildRoot ?? compiledRoot;
  const boundary = await createBuildBoundary(buildRoot);
  const configuredEntrypoint = options.entrypoint ?? actionEntrypoint;
  const entrypoint = await resolveContainedFile(
    boundary,
    configuredEntrypoint,
    "Action entrypoint",
  );
  if (extname(entrypoint.lexicalPath) !== ".js") {
    throw containmentError(
      `Action entrypoint must be an emitted .js file: ${entrypoint.lexicalPath}`,
    );
  }

  const closure = [];
  const pending = [entrypoint];
  const scheduled = new Set([entrypoint.lexicalPath]);
  while (pending.length > 0) {
    const source = pending.pop();
    if (source === undefined) {
      throw containmentError("internal traversal state was unexpectedly empty");
    }
    closure.push(source);

    const sourceText = await readFile(source.canonicalPath, "utf8");
    const importedFiles = ts.preProcessFile(sourceText, true, true).importedFiles;
    for (const { fileName: specifier } of importedFiles) {
      const classification = classifyImportSpecifier(
        specifier,
        source.lexicalPath,
      );
      if (classification === "node-builtin") {
        continue;
      }
      const dependency = await resolveCompiledDependency(
        boundary,
        source,
        specifier,
      );
      if (!scheduled.has(dependency.lexicalPath)) {
        scheduled.add(dependency.lexicalPath);
        pending.push(dependency);
      }
    }
  }

  return {
    boundary,
    records: closure.sort((left, right) =>
      left.lexicalPath.localeCompare(right.lexicalPath, "en"),
    ),
    entrypoint,
  };
}

export async function collectRuntimeClosure(options = {}) {
  const { records } = await collectRuntimeClosureRecords(options);
  return records.map(({ lexicalPath }) => lexicalPath);
}

async function createOutputBoundary(outputRoot) {
  const declaredRoot = resolve(outputRoot);
  await rm(declaredRoot, { recursive: true, force: true });
  await mkdir(declaredRoot, { recursive: true });
  const canonicalRoot = await realpath(declaredRoot);
  return { declaredRoot, canonicalRoot };
}

async function writePackagedFile(outputBoundary, destination, content) {
  const lexicalPath = resolve(destination);
  if (!isPathWithin(outputBoundary.declaredRoot, lexicalPath)) {
    throw containmentError(
      `package destination escapes the declared output root: ${lexicalPath}`,
    );
  }

  const parent = dirname(lexicalPath);
  await mkdir(parent, { recursive: true });
  const canonicalParent = await realpath(parent);
  if (!isPathWithin(outputBoundary.canonicalRoot, canonicalParent)) {
    throw containmentError(
      `package destination escapes the canonical output root through a symlink or reparse point: ${lexicalPath}`,
    );
  }

  await writeFile(lexicalPath, content);
  const canonicalPath = await realpath(lexicalPath);
  if (!isPathWithin(outputBoundary.canonicalRoot, canonicalPath)) {
    throw containmentError(
      `written package file escapes the canonical output root: ${lexicalPath}`,
    );
  }
}

export async function packageAction(options = {}) {
  const buildRoot = options.buildRoot ?? compiledRoot;
  const outputRoot = options.outputRoot ?? packagedRoot;
  const entrypoint = options.entrypoint ?? actionEntrypoint;
  const { boundary, records, entrypoint: resolvedEntrypoint } =
    await collectRuntimeClosureRecords({ buildRoot, entrypoint });
  const outputBoundary = await createOutputBoundary(outputRoot);

  const packagedPaths = [];
  for (const source of records) {
    const sourceRelativePath = relative(
      boundary.declaredRoot,
      source.lexicalPath,
    );
    if (
      sourceRelativePath === "" ||
      sourceRelativePath === ".." ||
      sourceRelativePath.startsWith(`..${sep}`) ||
      isAbsolute(sourceRelativePath)
    ) {
      throw containmentError(
        `source cannot be mapped into the package: ${source.lexicalPath}`,
      );
    }
    const destination = resolve(outputBoundary.declaredRoot, sourceRelativePath);
    await writePackagedFile(
      outputBoundary,
      destination,
      await readFile(source.canonicalPath),
    );
    packagedPaths.push(sourceRelativePath);
  }

  const packagedEntrypoint = resolve(
    outputBoundary.declaredRoot,
    relative(boundary.declaredRoot, resolvedEntrypoint.lexicalPath),
  );
  await readFile(packagedEntrypoint);
  return packagedPaths;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  await packageAction();
}
