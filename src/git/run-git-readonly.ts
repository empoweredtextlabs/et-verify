import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const GIT_EXECUTABLE = "git";
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const HARDENED_CONFIG_ARGS = [
  "-c",
  "diff.external=",
  "-c",
  "core.fsmonitor=",
  "-c",
  "diff.renames=false",
  "-c",
  "color.ui=false",
  "-c",
  "core.quotePath=true",
] as const;

export const DEFAULT_GIT_TIMEOUT_MS = 15_000;
export const DEFAULT_GIT_OUTPUT_CAP_BYTES = 16 * 1024 * 1024;

export type GitReadonlyFailureReason =
  | "INVALID_INVOCATION"
  | "SPAWN_FAILED"
  | "TIMED_OUT"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "NON_ZERO_EXIT";

export interface GitReadonlyInvocation {
  executable: "git";
  args: string[];
  environment: NodeJS.ProcessEnv;
  shell: false;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface GitProcessExecutionResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  spawnError?: string;
  timedOut?: boolean;
  outputLimitExceeded?: boolean;
}

export type GitProcessExecutor = (
  invocation: GitReadonlyInvocation,
) => Promise<GitProcessExecutionResult>;

export interface GitReadonlyRunResult {
  ok: boolean;
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  failureReason: GitReadonlyFailureReason | null;
  invocation: GitReadonlyInvocation | null;
}

export interface GitReadonlyRunner {
  run(repositoryPath: string, commandArgs: readonly string[]): Promise<GitReadonlyRunResult>;
}

export interface GitReadonlyRunnerOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  processExecutor?: GitProcessExecutor;
}

function allowedEnvironmentValue(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

function hardenedEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
  ]) {
    const value = allowedEnvironmentValue(name);
    if (value !== undefined) {
      environment[name] = value;
    }
  }

  let disabledGlobalConfig: string;
  do {
    disabledGlobalConfig = resolve(
      join(
        tmpdir(),
        `et-verify-git-config-disabled-${process.pid}-${randomUUID()}`,
        "global.config",
      ),
    );
  } while (existsSync(disabledGlobalConfig));
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: disabledGlobalConfig,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    LC_ALL: "C",
    LANG: "C",
  };
}

async function executeProcess(
  invocation: GitReadonlyInvocation,
): Promise<GitProcessExecutionResult> {
  return await new Promise((resolveResult) => {
    const child = spawn(invocation.executable, invocation.args, {
      env: invocation.environment,
      shell: invocation.shell,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let spawnError: string | undefined;

    const collect = (destination: Buffer[], chunk: Buffer): void => {
      const remaining = invocation.maxOutputBytes - capturedBytes;
      if (remaining > 0) {
        const admitted = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
        destination.push(admitted);
        capturedBytes += admitted.byteLength;
      }
      if (chunk.byteLength > remaining) {
        outputLimitExceeded = true;
        child.kill();
      }
    };

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error: Error) => {
      spawnError = error.message;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, invocation.timeoutMs);

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolveResult({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        ...(spawnError === undefined ? {} : { spawnError }),
        ...(timedOut ? { timedOut: true } : {}),
        ...(outputLimitExceeded ? { outputLimitExceeded: true } : {}),
      });
    });
  });
}

function invalidResult(): GitReadonlyRunResult {
  return {
    ok: false,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    exitCode: null,
    failureReason: "INVALID_INVOCATION",
    invocation: null,
  };
}

function invocationIsAllowed(commandArgs: readonly string[]): boolean {
  if (commandArgs.some((argument) => argument.includes("\0"))) {
    return false;
  }
  if (
    commandArgs.length === 2 &&
    commandArgs[0] === "rev-parse" &&
    commandArgs[1] === "--show-toplevel"
  ) {
    return true;
  }
  if (
    commandArgs.length === 4 &&
    commandArgs[0] === "rev-parse" &&
    commandArgs[1] === "--verify" &&
    commandArgs[2] === "--end-of-options"
  ) {
    return true;
  }
  if (
    commandArgs.length === 3 &&
    commandArgs[0] === "merge-base" &&
    OBJECT_ID.test(commandArgs[1] ?? "") &&
    OBJECT_ID.test(commandArgs[2] ?? "")
  ) {
    return true;
  }
  if (
    commandArgs.length === 4 &&
    commandArgs[0] === "status" &&
    commandArgs[1] === "--porcelain=v1" &&
    commandArgs[2] === "-z" &&
    commandArgs[3] === "--untracked-files=all"
  ) {
    return true;
  }
  if (
    commandArgs.length === 6 &&
    commandArgs[0] === "ls-tree" &&
    commandArgs[1] === "-z" &&
    commandArgs[2] === "--full-tree" &&
    OBJECT_ID.test(commandArgs[3] ?? "") &&
    commandArgs[4] === "--" &&
    (commandArgs[5] === ".et-verify/acceptance.json" ||
      commandArgs[5] === ".et-verify/checks.json")
  ) {
    return true;
  }
  if (
    commandArgs.length === 3 &&
    commandArgs[0] === "cat-file" &&
    commandArgs[1] === "blob" &&
    OBJECT_ID.test(commandArgs[2] ?? "")
  ) {
    return true;
  }

  const changedPathPrefix = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--name-only",
    "-z",
  ];
  const patchPrefix = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    "--no-renames",
    "--no-color",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--submodule=short",
  ];
  for (const prefix of [changedPathPrefix, patchPrefix]) {
    if (
      commandArgs.length === prefix.length + 2 &&
      prefix.every((value, index) => commandArgs[index] === value) &&
      OBJECT_ID.test(commandArgs[prefix.length] ?? "") &&
      OBJECT_ID.test(commandArgs[prefix.length + 1] ?? "")
    ) {
      return true;
    }
  }
  return false;
}

export function createGitReadonlyRunner(
  options: GitReadonlyRunnerOptions = {},
): GitReadonlyRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const maxOutputBytes =
    options.maxOutputBytes ?? DEFAULT_GIT_OUTPUT_CAP_BYTES;
  const processExecutor = options.processExecutor ?? executeProcess;

  return {
    async run(
      repositoryPath: string,
      commandArgs: readonly string[],
    ): Promise<GitReadonlyRunResult> {
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs <= 0 ||
        !Number.isSafeInteger(maxOutputBytes) ||
        maxOutputBytes <= 0 ||
        repositoryPath.length === 0 ||
        repositoryPath.includes("\0") ||
        !invocationIsAllowed(commandArgs)
      ) {
        return invalidResult();
      }

      const invocation: GitReadonlyInvocation = {
        executable: GIT_EXECUTABLE,
        args: [
          ...HARDENED_CONFIG_ARGS,
          "--no-pager",
          "-C",
          repositoryPath,
          ...commandArgs,
        ],
        environment: hardenedEnvironment(),
        shell: false,
        timeoutMs,
        maxOutputBytes,
      };

      let execution: GitProcessExecutionResult;
      try {
        execution = await processExecutor(invocation);
      } catch (error) {
        return {
          ok: false,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from(error instanceof Error ? error.message : String(error)),
          exitCode: null,
          failureReason: "SPAWN_FAILED",
          invocation,
        };
      }

      const combinedBytes = execution.stdout.byteLength + execution.stderr.byteLength;
      const failureReason: GitReadonlyFailureReason | null = execution.timedOut
        ? "TIMED_OUT"
        : execution.outputLimitExceeded || combinedBytes > maxOutputBytes
          ? "OUTPUT_LIMIT_EXCEEDED"
          : execution.spawnError !== undefined
            ? "SPAWN_FAILED"
            : execution.exitCode !== 0
              ? "NON_ZERO_EXIT"
              : null;
      return {
        ok: failureReason === null,
        stdout:
          combinedBytes <= maxOutputBytes
            ? execution.stdout
            : execution.stdout.subarray(0, maxOutputBytes),
        stderr:
          combinedBytes <= maxOutputBytes
            ? execution.stderr
            : Buffer.alloc(0),
        exitCode: execution.exitCode,
        failureReason,
        invocation,
      };
    },
  };
}
