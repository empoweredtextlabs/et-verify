import { appendFile } from "node:fs/promises";

import { canonicalV1Json } from "../v1/canonicalize.js";
import { renderGitHubSummary } from "./render-summary.js";
import { runGitHubActionBoundary } from "./run-integration.js";
import type { GitHubIntegrationResult } from "./types.js";

export const ET_STATUS_OUTPUT_NAME = "et-status";
export const ET_RESULT_JSON_OUTPUT_NAME = "et-result-json";

// ET caps the complete structured Action output record at 256 KiB UTF-8. For
// ASCII-heavy canonical JSON, this remains below GitHub's approximately 1 MiB
// UTF-16-accounted job-output limit even under the stricter interpretation that
// each ASCII character contributes two bytes.
export const MAX_ET_ACTION_OUTPUT_UTF8_BYTES = 256 * 1024;

export interface GitHubActionOutputPublication {
  etResultJson: string;
  structuredResultByteLength: number;
  outputRecordByteLength: number;
}

export type GitHubActionOutputAppender = (
  path: string,
  record: Buffer,
) => Promise<void>;

export type GitHubActionSummaryAppender = (
  path: string,
  summary: string,
) => Promise<void>;

async function appendOutputRecord(path: string, record: Buffer): Promise<void> {
  await appendFile(path, record);
}

async function appendSummary(path: string, summary: string): Promise<void> {
  await appendFile(path, summary, "utf8");
}

export function serializeGitHubIntegrationResult(
  result: GitHubIntegrationResult,
): string {
  return canonicalV1Json(result);
}

async function writeGitHubActionOutputRecord(
  result: GitHubIntegrationResult,
  options: {
    outputPath: string | undefined;
    appendOutput?: GitHubActionOutputAppender;
    maxOutputRecordBytes?: number;
  },
  terminatePartialLine: boolean,
): Promise<GitHubActionOutputPublication> {
  if (options.outputPath === undefined || options.outputPath.length === 0) {
    throw new Error("The GitHub Action output channel was unavailable.");
  }
  const etResultJson = serializeGitHubIntegrationResult(result);
  const structuredResultByteLength = Buffer.byteLength(etResultJson, "utf8");
  const record = Buffer.from(
    `${terminatePartialLine ? "\n" : ""}${ET_STATUS_OUTPUT_NAME}=${result.status}\n${ET_RESULT_JSON_OUTPUT_NAME}=${etResultJson}\n`,
    "utf8",
  );
  const maxOutputRecordBytes =
    options.maxOutputRecordBytes ?? MAX_ET_ACTION_OUTPUT_UTF8_BYTES;
  if (record.byteLength > maxOutputRecordBytes) {
    throw new Error("The complete GitHub Action output exceeded its bounded size limit.");
  }
  const write = options.appendOutput ?? appendOutputRecord;
  await write(options.outputPath, record);
  return {
    etResultJson,
    structuredResultByteLength,
    outputRecordByteLength: record.byteLength,
  };
}

export async function writeGitHubActionOutputs(
  result: GitHubIntegrationResult,
  options: {
    outputPath: string | undefined;
    appendOutput?: GitHubActionOutputAppender;
    maxOutputRecordBytes?: number;
  },
): Promise<GitHubActionOutputPublication> {
  return await writeGitHubActionOutputRecord(result, options, false);
}

async function integrationErrorResult(): Promise<GitHubIntegrationResult> {
  return await runGitHubActionBoundary(async () => {
    throw new Error("GitHub result channel write failed.");
  });
}

async function attemptSummary(
  result: GitHubIntegrationResult,
  options: {
    summaryPath: string | undefined;
    appendSummary?: GitHubActionSummaryAppender;
  },
): Promise<void> {
  if (options.summaryPath === undefined || options.summaryPath.length === 0) {
    return;
  }
  const write = options.appendSummary ?? appendSummary;
  await write(options.summaryPath, renderGitHubSummary(result));
}

async function publishIntegrationError(
  options: {
    outputPath: string | undefined;
    summaryPath: string | undefined;
    appendOutput?: GitHubActionOutputAppender;
    appendSummary?: GitHubActionSummaryAppender;
    maxOutputRecordBytes?: number;
  },
  terminatePartialOutputLine: boolean,
): Promise<GitHubIntegrationResult> {
  const failure = await integrationErrorResult();
  try {
    await writeGitHubActionOutputRecord(
      failure,
      options,
      terminatePartialOutputLine,
    );
  } catch {
    // The returned integration error remains non-passing even when no complete
    // machine-readable result can be published.
  }
  try {
    await attemptSummary(failure, options);
  } catch {
    // Every remaining safe surface is best-effort after a channel failure.
  }
  return failure;
}

export async function publishGitHubActionResult(
  result: GitHubIntegrationResult,
  options: {
    outputPath: string | undefined;
    summaryPath: string | undefined;
    appendOutput?: GitHubActionOutputAppender;
    appendSummary?: GitHubActionSummaryAppender;
    maxOutputRecordBytes?: number;
  },
): Promise<GitHubIntegrationResult> {
  try {
    await writeGitHubActionOutputs(result, options);
  } catch {
    return await publishIntegrationError(options, true);
  }
  try {
    await attemptSummary(result, options);
  } catch {
    return await publishIntegrationError(options, false);
  }
  return result;
}
