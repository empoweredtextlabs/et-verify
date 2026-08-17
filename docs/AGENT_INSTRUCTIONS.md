# ET Verify V1 coding-agent instruction

Copy the following into `AGENTS.md`, a coding-agent project/system instruction, or an equivalent agent configuration:

> For every ET-gated PR, fetch full target-branch history and compute the evaluated `baseCommit` from canonical commit IDs with `git merge-base <target-base-tip> <agent-head>`. Read the trusted `.et-verify/checks.json` from that evaluated base and run every configured `TEST` and `BUILD` check. The trusted evaluated-base configuration, never agent judgment about what is "applicable," defines the complete required set. Declare only `PASS` results and declare every configured check exactly once with its configured `checkId` and `kind`. Write `.et-verify/acceptance.json` with schema version 1, the computed `baseCommit`, the complete configured check set, and the complete exact final changed-path set including `.et-verify/acceptance.json` itself. Commit the declaration into the exact PR head. The declaration is a claim, not evidence. Regenerate and recommit it whenever the final path set changes or after merging, rebasing, or otherwise updating the branch in a way that changes the merge base; an older `baseCommit` is stale and produces `REVIEW REQUIRED`.

The declaration shape and production installation boundary are documented in the repository [README](../README.md).
