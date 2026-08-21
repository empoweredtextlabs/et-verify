# ET Verify public-alpha Quickstart

This is the shortest supported path from finding ET Verify to observing it on a coding-agent pull request. For the detailed execution and authority boundary, use the [ET Verify V1 GitHub Action reference](GITHUB_ACTION_V1.md).

## 1. Add the supplied required workflow

Copy [`examples/required-workflow/et-verify.yml`](../examples/required-workflow/et-verify.yml) exactly. Store it in the centrally governed repository and default branch selected by your organization, then select it as a required workflow or status policy without path filters. A pull-request-modifiable repository-local copy is not the supported authority topology.

The supplied workflow:

- runs for `pull_request`;
- grants `contents: read`;
- checks out `${{ github.event.pull_request.head.sha }}`;
- uses `fetch-depth: 0` for complete history;
- sets `persist-credentials: false`; and
- invokes `empoweredtextlabs/et-verify@474a1d79599a714ccb2cac28a0b34c1444ad86c7`.

Keep that exact full ET Verify commit pin. The consumer repository does not run `npm install`; the Action uses its committed runtime.

## 2. Configure required checks

Add `.et-verify/checks.json` to the repository through the bootstrap process described below. This minimal complete configuration runs the repository's `test` package script with the trusted Action's Node executable:

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

V1 supports only `TEST` and `BUILD`. `args` is a JSON array of at most 32 strings; each argument is at most 1,024 UTF-8 bytes and cannot contain a NUL byte. `timeoutMs` is an integer number of milliseconds from `1000` through `600000`. `command` is either `NODE` or an absolute executable path outside the evaluated repository. ET Verify starts the executable directly with the configured argument array and does not use a shell, so this is not an arbitrary shell-command contract. See [Base-pinned check configuration](GITHUB_ACTION_V1.md#base-pinned-check-configuration) for the full bounded schema.

ET Verify reads this configuration from the evaluated merge base, not from the pull-request head. That makes the first configuration pull request different:

1. The pull-request head contains the new `.et-verify/checks.json`.
2. The evaluated base does not contain a trusted check configuration yet.
3. ET Verify reports `REVIEW REQUIRED` with `TRUSTED_CHECK_CONFIG_UNAVAILABLE_AT_EVALUATED_BASE`.

This is intentional bootstrap behavior, not an Action crash, and it does not establish that the proposed configuration is otherwise good. A human must review and merge the bootstrap change through the organization's controlled onboarding or bypass process. Later pull requests can use the configuration once their evaluated merge base contains it.

## 3. Give the coding agent the ET instructions

Copy the exact [coding-agent instruction](AGENT_INSTRUCTIONS.md) into `AGENTS.md`, the agent's project/system instructions, or an equivalent configuration. The instruction requires the agent to use the complete evaluated-base check set, compute the merge base, and keep the declaration fresh.

## 4. Create the acceptance declaration

For each ET-gated pull request, the coding agent must:

1. Fetch complete target-branch history and compute `git merge-base <target-base-tip> <agent-head>`.
2. Read `.et-verify/checks.json` from that evaluated base and run every configured check.
3. Write and commit `.et-verify/acceptance.json` at the exact pull-request head.
4. Put the computed merge-base SHA in `baseCommit`.
5. List the complete final changed-path set in `changeScope.paths`, including `.et-verify/acceptance.json` itself.
6. List every configured check exactly once with its configured `checkId` and `kind`, declaring only `PASS`.
7. Regenerate and recommit the declaration whenever the final path set changes or the branch changes in a way that produces a different merge base.

Use the complete [acceptance declaration shape and example](../README.md#acceptance-declaration). The declaration is a claim; ET Verify produces the trusted check evidence itself.

## 5. Open or update the pull request

The supplied workflow runs on the exact pull-request head. ET Verify resolves the evaluated merge base, reads the trusted base configuration, captures the committed declaration and exact final-net changed paths, and then runs each configured check in a separate copied worktree. The Action summary reports the outcome under `AGENT CLAIMED` and `ET ESTABLISHED`.

## 6. Interpret the result

- `ACCEPTED`: the complete trusted evaluated-base check set was declared with matching identities, the observed checks passed for the bound head, and the exact changed-path declaration matched.
- `REVIEW REQUIRED`: ET Verify could not establish a required component from the available state or evidence. This includes the first configuration/bootstrap pull request.
- `BLOCKED`: ET Verify established a contradiction, such as a configured check failure or a deterministic exact-path-set mismatch.

Only `ACCEPTED` exits zero. ET Verify reports the result. Your team decides how that result fits into its review and merge policy. The result is not a correctness or security guarantee and does not replace human review.

See the [Worked Examples](WORKED_EXAMPLES.md) for one concrete pull request in each state.

## 7. Optionally consume the structured result

The Action publishes `et-result-json`, the canonical machine-readable integration result. A diagnostic or automation step can inspect it even when ET Verify returns nonzero:

```yaml
- id: et
  uses: empoweredtextlabs/et-verify@474a1d79599a714ccb2cac28a0b34c1444ad86c7

- name: Consume ET result
  if: always()
  env:
    ET_RESULT_JSON: ${{ steps.et.outputs.et-result-json }}
  run: |
    # Machine-readable ET result is available at:
    # steps.et.outputs.et-result-json
    node -e 'const result = JSON.parse(process.env.ET_RESULT_JSON); console.log(result.status)'
```

`if: always()` lets this consumer run after a non-passing ET Verify step. It does not neutralize the ET conclusion. ET Verify produces the result; the downstream step and your GitHub policy decide how to consume it.
