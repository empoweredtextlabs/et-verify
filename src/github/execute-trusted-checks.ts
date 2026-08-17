import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { V1TrustedActionCheckEvidence } from "../v1/types.js";
import {
  GITHUB_ACTION_PRODUCER_IDENTITY,
  type TrustedCheckExecution,
  type V1TrustedCheckConfiguration,
  type V1TrustedCheckDefinition,
} from "./types.js";

export const TRUSTED_CHECK_OUTPUT_CAP_BYTES = 1024 * 1024;

const CHILD_ENVIRONMENT_ALLOWLIST = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
] as const;

export interface TrustedCheckProcessInvocation {
  command: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  shell: false;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface TrustedCheckProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  spawnError: string | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
}

export type TrustedCheckProcessExecutor = (
  invocation: TrustedCheckProcessInvocation,
) => Promise<TrustedCheckProcessResult>;

function pathIsWithin(root: string, candidate: string): boolean {
  const delta = relative(resolve(root), resolve(candidate));
  return (
    delta === "" ||
    (!isAbsolute(delta) && delta !== ".." && !delta.startsWith(`..${sep}`))
  );
}

async function createIsolatedCheckWorktree(
  repositoryPath: string,
): Promise<string> {
  const destination = await mkdtemp(join(tmpdir(), "et-verify-check-worktree-"));
  try {
    const entries = await readdir(repositoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") {
        continue;
      }
      await cp(
        join(repositoryPath, entry.name),
        join(destination, entry.name),
        {
          recursive: true,
          force: false,
          errorOnExist: true,
          verbatimSymlinks: true,
        },
      );
    }
    return destination;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

export function buildTrustedCheckEnvironment(
  ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { CI: "true" };
  for (const name of CHILD_ENVIRONMENT_ALLOWLIST) {
    const value = ambient[name];
    if (value !== undefined && value.length > 0) {
      environment[name] = value;
    }
  }
  return environment;
}

async function executeProcess(
  invocation: TrustedCheckProcessInvocation,
): Promise<TrustedCheckProcessResult> {
  return await new Promise((resolveResult) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
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
    let spawnError: string | null = null;

    const collect = (destination: Buffer[], chunk: Buffer): void => {
      const remaining = invocation.maxOutputBytes - capturedBytes;
      if (remaining > 0) {
        const admitted = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
        destination.push(admitted);
        capturedBytes += admitted.byteLength;
      }
      if (chunk.byteLength > remaining && !outputLimitExceeded) {
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
        spawnError,
        timedOut,
        outputLimitExceeded,
      });
    });
  });
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function indeterminate(
  check: V1TrustedCheckDefinition,
  result: TrustedCheckProcessResult,
  reason: TrustedCheckExecution["indeterminateReason"],
): TrustedCheckExecution {
  return {
    checkId: check.checkId,
    kind: check.kind,
    state: "INDETERMINATE",
    evidence: null,
    indeterminateReason: reason,
    stdoutBytes: result.stdout.byteLength,
    stderrBytes: result.stderr.byteLength,
  };
}

export async function executeTrustedChecks(input: {
  configuration: V1TrustedCheckConfiguration;
  repositoryPath: string;
  evaluatedHeadSha: string;
  configSha256: string;
  runIdentity: string;
  processExecutor?: TrustedCheckProcessExecutor;
  ambientEnvironment?: NodeJS.ProcessEnv;
}): Promise<TrustedCheckExecution[]> {
  const execute = input.processExecutor ?? executeProcess;
  const executions: TrustedCheckExecution[] = [];
  for (const check of input.configuration.checks) {
    const executable = check.command === "NODE" ? process.execPath : check.command;
    if (!isAbsolute(executable) || pathIsWithin(input.repositoryPath, executable)) {
      executions.push({
        checkId: check.checkId,
        kind: check.kind,
        state: "INDETERMINATE",
        evidence: null,
        indeterminateReason: "SPAWN_FAILED",
        stdoutBytes: 0,
        stderrBytes: 0,
      });
      continue;
    }
    let checkWorktree: string;
    try {
      checkWorktree = await createIsolatedCheckWorktree(input.repositoryPath);
    } catch {
      executions.push({
        checkId: check.checkId,
        kind: check.kind,
        state: "INDETERMINATE",
        evidence: null,
        indeterminateReason: "SPAWN_FAILED",
        stdoutBytes: 0,
        stderrBytes: 0,
      });
      continue;
    }
    let result: TrustedCheckProcessResult;
    try {
      result = await execute({
        command: executable,
        args: [...check.args],
        cwd: checkWorktree,
        environment: buildTrustedCheckEnvironment(input.ambientEnvironment),
        shell: false,
        timeoutMs: check.timeoutMs,
        maxOutputBytes: TRUSTED_CHECK_OUTPUT_CAP_BYTES,
      });
    } catch {
      result = {
        exitCode: null,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        spawnError: "executor_rejected",
        timedOut: false,
        outputLimitExceeded: false,
      };
    } finally {
      await rm(checkWorktree, { recursive: true, force: true });
    }
    if (result.timedOut) {
      executions.push(indeterminate(check, result, "TIMED_OUT"));
      continue;
    }
    if (result.outputLimitExceeded) {
      executions.push(indeterminate(check, result, "OUTPUT_LIMIT_EXCEEDED"));
      continue;
    }
    if (result.spawnError !== null) {
      executions.push(indeterminate(check, result, "SPAWN_FAILED"));
      continue;
    }
    if (
      result.signal !== null ||
      result.exitCode === null ||
      !Number.isSafeInteger(result.exitCode) ||
      result.exitCode < 0 ||
      result.exitCode > 255
    ) {
      executions.push(indeterminate(check, result, "ABNORMAL_TERMINATION"));
      continue;
    }
    const evidence: V1TrustedActionCheckEvidence = {
      schemaVersion: 1,
      evidenceType: "CHECK_RESULT",
      source: "TRUSTED_ACTION_PROCESS",
      checkId: check.checkId,
      kind: check.kind,
      commandIdentity: check.commandIdentity,
      configSha256: input.configSha256,
      headCommit: input.evaluatedHeadSha,
      result: result.exitCode === 0 ? "PASS" : "FAIL",
      exitCode: result.exitCode,
      complete: true,
      producerIdentity: GITHUB_ACTION_PRODUCER_IDENTITY,
      runIdentity: input.runIdentity,
      output: {
        stdoutSha256: sha256(result.stdout),
        stderrSha256: sha256(result.stderr),
      },
    };
    executions.push({
      checkId: check.checkId,
      kind: check.kind,
      state: evidence.result,
      evidence,
      indeterminateReason: null,
      stdoutBytes: result.stdout.byteLength,
      stderrBytes: result.stderr.byteLength,
    });
  }
  return executions;
}
