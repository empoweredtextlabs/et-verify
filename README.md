# ET Verify

## What ET Verify is

ET Verify is a public GitHub Action alpha for reviewing coding-agent pull requests before merge.

The agent reports what it changed and which required checks passed. Verify compares that report against repository state and trusted check evidence. It does not certify the code.

## Alpha status

The supported public-alpha surface is the GitHub Action only. The CLI is not part of the supported public-alpha surface.

## What it checks

Verify answers three bounded questions:

- Did the agent change only what it said it changed?
- Did every organization-configured required `TEST` or `BUILD` check satisfy the required evidence?
- Do the declaration and evidence belong to this exact evaluated pull-request state?

## Three results

- `ACCEPTED`: The required report is supported by the trusted evidence Verify checks.
- `REVIEW_REQUIRED`: Verify cannot establish the required result from current evidence.
- `BLOCKED`: Trusted evidence contradicts an organization-required condition or declaration.

Only `ACCEPTED` exits successfully. A human and the organization's GitHub rules remain responsible for the merge decision.

## Install / setup

Start with the supplied [required-workflow template](examples/required-workflow/et-verify.yml). Store that workflow in the centrally governed location selected by your organization, and require it through your GitHub ruleset without path filters.

Install the Action using this exact immutable full commit SHA:

```yaml
uses: empoweredtextlabs/et-verify@474a1d79599a714ccb2cac28a0b34c1444ad86c7
```

Keep this exact full SHA; do not replace it with `main` or a mutable tag. Keep the template's exact PR-head checkout, full history, disabled credential persistence, and read-only contents permission. No npm installation is required; the committed runtime is under `action/dist/**`.

Follow the [Quickstart](docs/QUICKSTART.md) for the shortest supported setup path, then use the [Worked Examples](docs/WORKED_EXAMPLES.md) to see each result state in a concrete pull request. See [ET Verify V1 GitHub Action](docs/GITHUB_ACTION_V1.md) for the detailed execution and authority boundary, and give coding agents the exact [agent instructions](docs/AGENT_INSTRUCTIONS.md).

## Required trust model

- Trusted check configuration is owned by the organization and read from the evaluated base state in `.et-verify/checks.json`.
- The coding agent does not choose which configured checks matter.
- The coding agent writes and commits `.et-verify/acceptance.json`.
- The Action reads trusted configuration from the evaluated merge base and the declaration from the exact pull-request head.
- GitHub branch and ruleset authority remains external to the Action. One Action run cannot prove that the organization configured those controls correctly.

The evaluated-base configuration is the complete required check set. A configured check omitted from the declaration produces `REVIEW_REQUIRED` unless qualifying trusted evidence shows that it failed, in which case the result is `BLOCKED`. Any qualifying failure for a configured check produces `BLOCKED`, whether that check was declared, omitted, or the declaration is absent. A declaration/configuration mismatch by `(checkId, kind)` produces explicit `REVIEW_REQUIRED` diagnostics. Incomplete required-check coverage never produces `ACCEPTED`.

## Acceptance declaration

The coding agent commits `.et-verify/acceptance.json` at the exact pull-request head. The V1 declaration has exactly four top-level fields:

- `schemaVersion` must be `1`.
- `baseCommit` is the full 40-character lowercase commit SHA produced by `git merge-base <target-base-tip> <agent-head>` for the evaluated pull-request state.
- `changeScope` has `kind: "EXACT_PATH_SET"`; its `paths` array is the complete, unique set of normalized repository-relative paths changed between that base and head. The set must include `.et-verify/acceptance.json` itself.
- `checkResults` is a non-empty array containing every check from the evaluated-base `.et-verify/checks.json` exactly once by `checkId` and `kind`. V1 declarations contain only `declaredResult: "PASS"`.

This is a complete declaration for a pull request whose only other changed path is `src/change.js` and whose evaluated-base configuration contains one `TEST` check named `test`:

```json
{
  "schemaVersion": 1,
  "baseCommit": "0123456789abcdef0123456789abcdef01234567",
  "changeScope": {
    "kind": "EXACT_PATH_SET",
    "paths": [
      ".et-verify/acceptance.json",
      "src/change.js"
    ]
  },
  "checkResults": [
    {
      "checkId": "test",
      "kind": "TEST",
      "declaredResult": "PASS"
    }
  ]
}
```

The declaration is the agent's claim, not check evidence. ET Verify reads it from the committed head and independently evaluates it against the exact changed-path set and trusted check evidence. Regenerate and recommit it whenever the final path set or merge base changes. See the [Quickstart](docs/QUICKSTART.md) for the operating sequence and the [V1 GitHub Action reference](docs/GITHUB_ACTION_V1.md) for the deeper contract.

## Bootstrap

The first trusted `.et-verify/checks.json` requires a controlled bootstrap merge. A pull request cannot authorize its own new trust base, so the first pull request that adds the configuration receives `REVIEW_REQUIRED`. A human must review and merge that bootstrap change through the organization's controlled onboarding or bypass process before requiring Verify on later pull requests.

## Outputs

The Action publishes:

- `et-status`: `ACCEPTED`, `REVIEW_REQUIRED`, or `BLOCKED`.
- `et-result-json`: the canonical machine-readable integration result.

`REVIEW_REQUIRED` and `BLOCKED` intentionally fail the Action step. A downstream diagnostic step may read `et-result-json` with `if: always()`, but it must not neutralize the failed conclusion.

## Limitations

- Verify does not certify code correctness.
- Verify does not establish security.
- Verify does not establish that tests are sufficient, complete, or unweakened.
- One Action run does not prove organization, branch, or ruleset authority.
- Configured checks are isolated from one another but are not network-sandboxed.
- The `merge_group` event and merge queues are unsupported in this alpha.
- GitHub Enterprise Server compatibility has not been established for this alpha; no GHES support claim is made.
- This is alpha software and is not a production-maturity claim.

## CLI boundary

The CLI is not installed, versioned, or supported as part of this public alpha. It is not a public product workflow for this release.

## License

ET Verify is licensed under the [Apache License 2.0](LICENSE).

## Security / contact

Read [SECURITY.md](SECURITY.md) before reporting a vulnerability. Report potential vulnerabilities privately to [abram@empoweredtextlabs.com](mailto:abram@empoweredtextlabs.com). Do not include secrets in a report.
