# ET Verify V1 GitHub Action

## Supported authority topology

V1 supports `ORGANIZATION_RULESET_REQUIRED_WORKFLOW` only. The workflow source is selected and enforced by organization ruleset policy from a centrally governed repository/default branch. The evaluated pull request cannot modify that workflow or the immutable ET Action revision it invokes. The required workflow/check must be required before merge, and no path filters may make ET optional.

An ordinary repository-local workflow modified by the pull request is `NON_AUTHORITATIVE_DEMO` material. It does not satisfy the hostile/careless-agent producer-authority guarantee and is not supplied as the production topology.

The authoritative template is [`examples/required-workflow/et-verify.yml`](../examples/required-workflow/et-verify.yml). Before activation, replace `<PUBLIC_RELEASE_COMMIT_SHA>` in `empoweredtextlabs/et-verify@<PUBLIC_RELEASE_COMMIT_SHA>` with the reviewed full public commit SHA containing `action.yml` and `action/dist/**`. The template uses `pull_request`, grants only `contents: read`, supplies no secrets, persists no checkout credential, checks out `pull_request.head.sha`, and uses `fetch-depth: 0`.

V1 does not administer rulesets through an API. An organization administrator must select the central workflow as a required workflow/status policy. A missing ET result must remain merge-blocking.

## Identity and merge-base

The Action reads canonical full SHAs from the trusted GitHub event:

- `githubBaseTipSha = pull_request.base.sha`
- `githubHeadSha = pull_request.head.sha`
- `evaluatedHeadSha = githubHeadSha`
- `evaluatedBaseSha = git merge-base githubBaseTipSha githubHeadSha`
- `acceptanceTargetRef = evaluatedHeadSha`

It independently verifies that checked-out `HEAD` equals `evaluatedHeadSha`. It never uses `GITHUB_SHA`, a merge ref, a symbolic branch, or the base tip as the evaluator patch base. The hardened Git runner admits only `git merge-base <OBJECT_ID> <OBJECT_ID>` for merge-base resolution.

Missing objects, shallow/incomplete history, disjoint history, Git failure, or malformed merge-base output produces non-passing `REVIEW_REQUIRED` with `MERGE_BASE_UNAVAILABLE`. There is no base-tip fallback.

`MERGE_QUEUE_NOT_SUPPORTED_IN_V1_ALPHA`. The `merge_group` event and every event other than `pull_request` fail closed. Do not attach this V1 alpha workflow to a merge-queue ruleset that requires `merge_group` support.

## Base-pinned check configuration

The only trusted check configuration path is `.et-verify/checks.json`. Its exact blob bytes are read from `evaluatedBaseSha` and hashed as `configSha256`; HEAD and worktree bytes are never substituted. The bounded schema is:

```json
{
  "schemaVersion": 1,
  "checks": [
    {
      "checkId": "test",
      "kind": "TEST",
      "command": "NODE",
      "args": ["--run", "test"],
      "timeoutMs": 600000
    }
  ]
}
```

Only `TEST` and `BUILD` exist. Checks have a bounded ID, bounded argument vector, and timeout from 1 second through 10 minutes. `NODE` means the trusted Action's absolute Node executable; an explicit absolute executable outside the evaluated repository is also allowed. There is no shell, conditional expression, evidence path, output path, or general policy language.

If configuration is absent at `evaluatedBaseSha`, the result is `REVIEW_REQUIRED` with `TRUSTED_CHECK_CONFIG_UNAVAILABLE_AT_EVALUATED_BASE`. This includes the bootstrap PR that introduces the file and long-lived branches whose merge-base predates it. A new HEAD configuration cannot self-authorize checks.

Changes to `.et-verify/checks.json` or `.github/workflows/**` route through the V1 `trustBaseReview` seam as `REVIEW_REQUIRED` with `TRUST_BASE_CHANGED`. This means authority assumptions changed; it is not a claim of maliciousness.

## Required-check coverage invariant

The complete check set in the trusted evaluated-base `.et-verify/checks.json` is required for acceptance. The declaration's check set must match that configured set exactly by `(checkId, kind)`; the agent does not decide which configured checks are applicable.

- A configured check absent from the declaration produces `REVIEW_REQUIRED` with `required_check_not_declared:<checkId>` when no qualifying FAIL evidence exists for it.
- Qualifying FAIL evidence for a configured check produces `BLOCKED` with `required_check_failed:<checkId>` whether or not that check was declared. Failure is dominant so omission is never cheaper than declaring the failing check honestly.
- A declaration entry whose `checkId` is absent from the trusted configuration produces `REVIEW_REQUIRED` with `declared_check_not_configured:<checkId>`.
- A declaration entry whose `checkId` exists but whose `kind` differs from the configured kind produces `REVIEW_REQUIRED` with `declared_check_kind_mismatch:<checkId>`.

The extra-check and kind-mismatch cases are declaration/configuration binding failures, not missing-evidence failures; they do not use `required_check_evidence_missing:<checkId>`. If the authoritative evaluated-base configuration cannot be loaded, the integration fails closed before evaluation and never produces `ACCEPTED`.

## Trusted evidence producer

The Action snapshots the exact final-net patch and committed `.et-verify/acceptance.json` from `evaluatedHeadSha` before any configured PR command runs. It then copies the clean exact-head checkout, excluding `.git`, into a separate trusted-parent-selected temporary worktree for each check. One check cannot mutate the starting worktree used by a later check. The trusted parent captures exit status and bounded stdout/stderr, constructs the evidence record itself, and supplies it to the evaluator through `IN_PROCESS_TRUSTED_EVIDENCE`. No evidence file path is exposed to configuration or child code, and the existing out-of-tree external evidence loader remains unchanged and explicit.

The child runs directly without a shell. Output capture is capped at 1 MiB, execution has the configured timeout, and the parent terminates the child on timeout/output overflow where the platform supports termination. Its environment is an allowlist containing only executable-discovery/temporary-directory values plus `CI=true`. In particular, it does not receive `GITHUB_OUTPUT`, `GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_STEP_SUMMARY`, GitHub credentials/secrets, or any ET evidence/output channel.

Exit zero produces trusted `PASS`; a normal nonzero exit produces trusted `FAIL`. Timeout, spawn failure, output overflow, or abnormal termination produces no conclusive PASS/FAIL evidence and routes to `REVIEW_REQUIRED` as `CHECK_EXECUTION_INDETERMINATE`.

## Result and failure mapping

- `et-status` is the short ET terminal status for human and workflow convenience.
- `et-result-json` is the canonical machine-readable serialization of the complete V1 `GitHubIntegrationResult`.
- `ACCEPTED` publishes both outputs and exits zero.
- `REVIEW_REQUIRED` publishes both outputs and exits nonzero.
- `BLOCKED` publishes both outputs and exits nonzero.
- An unexpected exception or rejected promise is caught at the outer Action boundary, rendered as `INTEGRATION_ERROR`, and exits nonzero.

Both outputs are written by the trusted parent only after final adjudication. The JSON uses the V1 `canonicalV1Json` serializer and is the same result object that drives the summary and exit code; consumers do not need to scrape logs or Markdown. ET caps the complete structured Action output record, including output names, assignments, and separators, at 256 KiB UTF-8. For ASCII-heavy canonical JSON, this remains below GitHub's approximately 1 MiB UTF-16-accounted job-output limit even under the stricter interpretation that each ASCII character contributes two bytes. ET never truncates the result. A missing, malformed, oversized, partial, or failed output-channel write routes to non-passing `INTEGRATION_ERROR`; if a complete integration-error result cannot itself be published, the step still fails.

An absent, truncated, malformed, or otherwise unparseable `et-result-json` is not a valid ET result. Consumers must treat it as unavailable rather than infer a status from partial content.

A downstream machine consumer can inspect the structured result even when ET intentionally returns nonzero:

```yaml
- id: et
  uses: empoweredtextlabs/et-verify@<PUBLIC_RELEASE_COMMIT_SHA>

- name: Consume ET result
  if: always()
  env:
    ET_RESULT_JSON: ${{ steps.et.outputs.et-result-json }}
  run: |
    # Machine-readable ET result is available at:
    # steps.et.outputs.et-result-json
    node -e 'const result = JSON.parse(process.env.ET_RESULT_JSON); console.log(result.status)'
```

`if: always()` is required for this diagnostic/automation step because `REVIEW_REQUIRED` and `BLOCKED` intentionally make the ET step non-passing. Reading `et-result-json` does not neutralize that conclusion: consumers must continue to treat ET's nonzero Action conclusion as authoritative for workflow gating.

The step summary separates `AGENT CLAIMED` from `ET ESTABLISHED`, then gives required human action, compact check/scope evidence, and expandable identities/limitations. Coverage and configured-failure actions name the affected `checkId` values. Agent-authored symbols receive no ET authority semantics.

## Assurance boundary

ET establishes only that every check in the complete trusted `evaluatedBaseSha` configuration was declared with the exact configured identity and returned the observed result against the bound `evaluatedHeadSha` under the trusted Action execution path.

ET does not establish test sufficiency, coverage adequacy, that PR code did not weaken tests, dependency safety, security, behavioral correctness, or absence of malicious changes. Human and branch policy retain consequence authority. V1 introduces no production network calls, GitHub App, Checks/Statuses API use, credentials, retained history, dashboard, or merge-queue support.

## Packaging

`npm run package:action` compiles the TypeScript and copies the runtime JavaScript dependency closure into `action/dist/**`. The consumer repository does not run `npm install`; GitHub executes the packaged Action with the `node24` runtime declared in `action.yml`.
