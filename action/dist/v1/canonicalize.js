import { createHash } from "node:crypto";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function canonicalizeV1Value(value) {
    if (Array.isArray(value)) {
        return value.map(canonicalizeV1Value);
    }
    if (isRecord(value)) {
        return Object.fromEntries(Object.keys(value)
            .sort()
            .filter((key) => value[key] !== undefined)
            .map((key) => [key, canonicalizeV1Value(value[key])]));
    }
    return value;
}
export function canonicalV1Json(value) {
    return JSON.stringify(canonicalizeV1Value(value));
}
export function hashV1Value(value) {
    return createHash("sha256").update(canonicalV1Json(value), "utf8").digest("hex");
}
//# sourceMappingURL=canonicalize.js.map