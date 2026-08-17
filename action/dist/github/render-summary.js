function displayStatus(status) {
    return status === "REVIEW_REQUIRED" ? "REVIEW REQUIRED" : status;
}
function code(value) {
    return value === null ? "unavailable" : `\`${value.replaceAll("`", "\\`")}\``;
}
export function renderGitHubSummary(result) {
    const evaluator = result.evaluatorResult;
    const claimedChecks = evaluator?.agentClaimed.declaration?.checkResults
        .map((check) => `${check.kind} ${code(check.checkId)} claimed PASS`)
        .join("; ") ?? "No valid committed acceptance claim was available.";
    const established = evaluator === null
        ? "The GitHub integration did not establish a complete V1 evaluation."
        : `State binding: ${evaluator.etEstablished.stateBinding}; scope: ${evaluator.etEstablished.scopeState}.`;
    const requiredAction = evaluator?.requiredHumanAction.join(" ") ??
        "Resolve the integration condition and rerun the required ET workflow.";
    const checks = result.checks.length === 0
        ? "No configured check result was established."
        : result.checks
            .map((check) => `- ${check.kind} ${code(check.checkId)}: ${check.state}${check.indeterminateReason === null
            ? ""
            : ` (${check.indeterminateReason})`}`)
            .join("\n");
    const identity = result.identity;
    const limitations = evaluator?.limitations ?? [
        "No semantic assurance is inferred from an incomplete integration run.",
    ];
    return [
        `# ET VERIFY — ${displayStatus(result.status)}`,
        "",
        result.reason,
        "",
        "## AGENT CLAIMED",
        "",
        claimedChecks,
        "",
        "## ET ESTABLISHED",
        "",
        established,
        "",
        "## Required human action",
        "",
        requiredAction,
        "",
        "## Check and scope evidence",
        "",
        checks,
        "",
        "<details>",
        "<summary>Identity and limitations</summary>",
        "",
        `- GitHub base tip: ${code(identity?.githubBaseTipSha ?? null)}`,
        `- GitHub head: ${code(identity?.githubHeadSha ?? null)}`,
        `- Evaluated base (merge-base): ${code(identity?.evaluatedBaseSha ?? null)}`,
        `- Evaluated head: ${code(identity?.evaluatedHeadSha ?? null)}`,
        `- Base-pinned config SHA-256: ${code(result.configSha256)}`,
        `- Runtime authority topology: ${code(result.runtimeAuthorityTopology)}`,
        `- Recommended production topology: ${code(result.recommendedProductionTopology)}`,
        `- Merge queue: ${code(result.mergeQueueSupport)}`,
        "",
        ...limitations.map((limitation) => `- ${limitation}`),
        "",
        "</details>",
        "",
    ].join("\n");
}
//# sourceMappingURL=render-summary.js.map