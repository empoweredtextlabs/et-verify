import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { compareCanonicalStrings } from "../canonical-order.js";
import { createGitReadonlyRunner } from "../git/run-git-readonly.js";
import { hashV1Value } from "../v1/canonicalize.js";
import { V1_TRUSTED_CHECK_CONFIG_PATH } from "./types.js";
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const CHECK_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_CHECKS = 20;
const MAX_ARGUMENTS = 32;
const MAX_ARGUMENT_BYTES = 1024;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 10 * 60 * 1_000;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value, expected) {
    const actual = Object.keys(value).sort(compareCanonicalStrings);
    const wanted = [...expected].sort(compareCanonicalStrings);
    return (actual.length === wanted.length &&
        actual.every((key, index) => key === wanted[index]));
}
function parseTreeEntry(bytes) {
    if (bytes.byteLength === 0) {
        return "MISSING";
    }
    if (bytes[bytes.byteLength - 1] !== 0) {
        return null;
    }
    let text;
    try {
        text = UTF8.decode(bytes.subarray(0, bytes.byteLength - 1));
    }
    catch {
        return null;
    }
    const match = text.match(/^(100644|100755) blob ([0-9a-f]{40}(?:[0-9a-f]{24})?)\t\.et-verify\/checks\.json$/);
    return match?.[2] ?? null;
}
function validCommand(value) {
    return (typeof value === "string" &&
        value.length > 0 &&
        value.length <= 512 &&
        !value.includes("\0") &&
        !value.includes("\n") &&
        !value.includes("\r") &&
        (value === "NODE" || isAbsolute(value)));
}
function parseConfiguration(bytes) {
    let parsed;
    try {
        parsed = JSON.parse(UTF8.decode(bytes));
    }
    catch {
        return null;
    }
    if (!isRecord(parsed) ||
        !exactKeys(parsed, ["schemaVersion", "checks"]) ||
        parsed.schemaVersion !== 1 ||
        !Array.isArray(parsed.checks) ||
        parsed.checks.length === 0 ||
        parsed.checks.length > MAX_CHECKS) {
        return null;
    }
    const ids = new Set();
    const checks = [];
    for (const candidate of parsed.checks) {
        if (!isRecord(candidate) ||
            !exactKeys(candidate, ["checkId", "kind", "command", "args", "timeoutMs"]) ||
            typeof candidate.checkId !== "string" ||
            !CHECK_ID.test(candidate.checkId) ||
            ids.has(candidate.checkId) ||
            (candidate.kind !== "TEST" && candidate.kind !== "BUILD") ||
            !validCommand(candidate.command) ||
            !Array.isArray(candidate.args) ||
            candidate.args.length > MAX_ARGUMENTS ||
            !candidate.args.every((argument) => typeof argument === "string" &&
                Buffer.byteLength(argument, "utf8") <= MAX_ARGUMENT_BYTES &&
                !argument.includes("\0")) ||
            !Number.isSafeInteger(candidate.timeoutMs) ||
            candidate.timeoutMs < MIN_TIMEOUT_MS ||
            candidate.timeoutMs > MAX_TIMEOUT_MS) {
            return null;
        }
        ids.add(candidate.checkId);
        const args = [...candidate.args];
        checks.push({
            checkId: candidate.checkId,
            kind: candidate.kind,
            command: candidate.command,
            args,
            timeoutMs: candidate.timeoutMs,
            commandIdentity: `sha256:${hashV1Value({
                execution: "DIRECT_EXEC_NO_SHELL",
                command: candidate.command,
                args,
            })}`,
        });
    }
    checks.sort((left, right) => compareCanonicalStrings(left.checkId, right.checkId));
    return { schemaVersion: 1, checks };
}
export async function loadTrustedCheckConfiguration(input) {
    const runner = input.runner ?? createGitReadonlyRunner();
    const tree = await runner.run(input.repositoryPath, [
        "ls-tree",
        "-z",
        "--full-tree",
        input.evaluatedBaseSha,
        "--",
        V1_TRUSTED_CHECK_CONFIG_PATH,
    ]);
    if (!tree.ok) {
        return {
            ok: false,
            reasonCode: "TRUSTED_CHECK_CONFIG_UNAVAILABLE_AT_EVALUATED_BASE",
            reason: "Trusted check configuration could not be read from the evaluated base commit.",
        };
    }
    const objectId = parseTreeEntry(tree.stdout);
    if (objectId === "MISSING") {
        return {
            ok: false,
            reasonCode: "TRUSTED_CHECK_CONFIG_UNAVAILABLE_AT_EVALUATED_BASE",
            reason: "No trusted check configuration exists at the evaluated base; bootstrap and pre-configuration PRs require review.",
        };
    }
    if (objectId === null || !OBJECT_ID.test(objectId)) {
        return {
            ok: false,
            reasonCode: "TRUSTED_CHECK_CONFIG_INVALID",
            reason: "The evaluated-base check configuration tree entry was malformed.",
        };
    }
    const blob = await runner.run(input.repositoryPath, ["cat-file", "blob", objectId]);
    if (!blob.ok || blob.stdout.byteLength > MAX_CONFIG_BYTES) {
        return {
            ok: false,
            reasonCode: "TRUSTED_CHECK_CONFIG_INVALID",
            reason: "The evaluated-base check configuration blob was unavailable or oversized.",
        };
    }
    const configuration = parseConfiguration(blob.stdout);
    if (configuration === null) {
        return {
            ok: false,
            reasonCode: "TRUSTED_CHECK_CONFIG_INVALID",
            reason: "The evaluated-base check configuration did not satisfy the bounded V1 schema.",
        };
    }
    return {
        ok: true,
        configuration,
        configSha256: createHash("sha256").update(blob.stdout).digest("hex"),
        blobGitObjectId: objectId,
    };
}
//# sourceMappingURL=load-trusted-check-config.js.map