import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { packageAction } from "../scripts/package-action.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

async function write(root, relativePath, content) {
  const destination = join(root, ...relativePath.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, "utf8");
  return destination;
}

async function listFiles(root) {
  const paths = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        paths.push(relative(root, path).replaceAll("\\", "/"));
      }
    }
  }
  await visit(root);
  return paths.sort((left, right) => left.localeCompare(right, "en"));
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "et-verify-packager-test-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const buildRoot = join(root, "dist");
  const outputRoot = join(root, "action", "dist");
  const entrypoint = join(buildRoot, "entry.js");
  await mkdir(buildRoot, { recursive: true });
  return { root, buildRoot, outputRoot, entrypoint };
}

async function packageFixture(t, entrySource, files = {}) {
  const fixture = await createFixture(t);
  await writeFile(fixture.entrypoint, entrySource, "utf8");
  for (const [relativePath, content] of Object.entries(files)) {
    await write(fixture.buildRoot, relativePath, content);
  }
  const packagedPaths = await packageAction(fixture);
  return { ...fixture, packagedPaths };
}

test("ordinary relative import inside the build root is packaged", async (t) => {
  const fixture = await packageFixture(t, 'import "./dependency.js";\n', {
    "dependency.js": "export const value = 1;\n",
  });
  assert.deepEqual(fixture.packagedPaths, ["dependency.js", "entry.js"]);
  assert.deepEqual(await listFiles(fixture.outputRoot), [
    "dependency.js",
    "entry.js",
  ]);
});

test("valid node: builtin is accepted and is not copied", async (t) => {
  const fixture = await packageFixture(
    t,
    'import { readFile } from "node:fs/promises";\n',
  );
  assert.deepEqual(fixture.packagedPaths, ["entry.js"]);
  assert.deepEqual(await listFiles(fixture.outputRoot), ["entry.js"]);
});

test("unresolved relative import fails packaging", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(fixture.entrypoint, 'import "./missing.js";\n', "utf8");
  await assert.rejects(
    packageAction(fixture),
    /compiled dependency .* does not exist or cannot be resolved/,
  );
});

test("lexical parent escape outside the build root fails packaging", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(fixture.entrypoint, 'import "..\/outside.js";\n', "utf8");
  await writeFile(join(fixture.root, "outside.js"), "export {};\n", "utf8");
  await assert.rejects(
    packageAction(fixture),
    /escapes the declared build root/,
  );
});

const unsupportedSpecifiers = [
  ["POSIX absolute path", "/absolute/path.js"],
  ["Windows drive-letter path", String.raw`C:\outside\dependency.js`],
  ["UNC path", String.raw`\\server\share\dependency.js`],
  ["file: URL", "file:///outside/dependency.js"],
  ["bare package", "some-package"],
  ["unsupported URL scheme", "https://example.invalid/dependency.js"],
];

for (const [description, specifier] of unsupportedSpecifiers) {
  test(`${description} import fails packaging`, async (t) => {
    const fixture = await createFixture(t);
    await writeFile(
      fixture.entrypoint,
      `import ${JSON.stringify(specifier)};\n`,
      "utf8",
    );
    await assert.rejects(
      packageAction(fixture),
      new RegExp(`unsupported import specifier .*entry\\.js`),
    );
  });
}

test("local dependency whose reparse target escapes the build root fails", async (t) => {
  const fixture = await createFixture(t);
  const outsideDirectory = join(fixture.root, "outside");
  const linkedDirectory = join(fixture.buildRoot, "linked");
  await write(outsideDirectory, "dependency.js", "export const escaped = true;\n");
  try {
    await symlink(
      outsideDirectory,
      linkedDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EACCES", "EPERM", "ENOSYS", "ENOTSUP"].includes(error.code)) {
      t.skip(`symlink/reparse fixture unsupported: ${error.code}`);
      return;
    }
    throw error;
  }
  await writeFile(
    fixture.entrypoint,
    'import "./linked/dependency.js";\n',
    "utf8",
  );
  await assert.rejects(
    packageAction(fixture),
    /escapes the canonical build root through a symlink or reparse point/,
  );
});

test("missing entrypoint fails packaging", async (t) => {
  const fixture = await createFixture(t);
  await assert.rejects(
    packageAction(fixture),
    /Action entrypoint does not exist or cannot be resolved/,
  );
});

test("duplicate and cyclic relative imports terminate deterministically", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(
    fixture.entrypoint,
    'import "./a.js";\nimport "./a.js";\n',
    "utf8",
  );
  await write(fixture.buildRoot, "a.js", 'import "./b.js";\nexport const a = 1;\n');
  await write(fixture.buildRoot, "b.js", 'import "./a.js";\nexport const b = 2;\n');

  const firstPaths = await packageAction(fixture);
  const secondOutputRoot = join(fixture.root, "second-action", "dist");
  const secondPaths = await packageAction({ ...fixture, outputRoot: secondOutputRoot });
  assert.deepEqual(firstPaths, ["a.js", "b.js", "entry.js"]);
  assert.deepEqual(secondPaths, firstPaths);
  assert.deepEqual(await listFiles(secondOutputRoot), firstPaths);
});

test("current candidate runtime packages to the exact 21-file closure", async (t) => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), "et-verify-current-runtime-package-test-"),
  );
  t.after(async () => await rm(fixtureRoot, { recursive: true, force: true }));
  const generatedRoot = join(fixtureRoot, "action", "dist");
  const candidateRoot = join(repositoryRoot, "action", "dist");

  const packagedPaths = (
    await packageAction({ outputRoot: generatedRoot })
  ).map((path) => path.replaceAll("\\", "/"));
  const generatedPaths = await listFiles(generatedRoot);
  const candidatePaths = await listFiles(candidateRoot);
  assert.equal(packagedPaths.length, 21);
  assert.deepEqual(generatedPaths, candidatePaths);
  assert.deepEqual(generatedPaths, packagedPaths);
  for (const relativePath of generatedPaths) {
    assert.equal(
      await sha256(join(generatedRoot, ...relativePath.split("/"))),
      await sha256(join(candidateRoot, ...relativePath.split("/"))),
      relativePath,
    );
  }
});
