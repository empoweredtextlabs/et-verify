# ET Verify worked examples

In each example, an engineer asks a coding agent to implement a small change on a pull request. The examples separate what the agent declares from what ET Verify can establish from the repository state and trusted Action execution.

## 1. ACCEPTED

The engineer asks the agent to change `src/change.js`. The evaluated base already contains this complete `.et-verify/checks.json`:

```json
{
  "schemaVersion": 1,
  "checks": [
    {
      "checkId": "test",
      "kind": "TEST",
      "command": "NODE",
      "args": ["checks/pass.mjs"],
      "timeoutMs": 5000
    }
  ]
}
```

The agent computes the merge base as `1111111111111111111111111111111111111111`. The final pull-request patch changes only `src/change.js` and the declaration itself, so the agent commits this complete `.et-verify/acceptance.json`:

```json
{
  "schemaVersion": 1,
  "baseCommit": "1111111111111111111111111111111111111111",
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

`AGENT CLAIMED` records that the exact changed-path set contains those two paths and that the configured `TEST` check named `test` passed.

`ET ESTABLISHED` independently resolves the same merge base and head, observes those exact two changed paths, reads the `test` configuration from the base, and executes it against the bound head. The command exits zero, so ET Verify produces trusted `PASS` evidence. State binding is `BOUND`, scope is `MATCH`, and the check is `PASS_ESTABLISHED`.

The result is `ACCEPTED`.

This establishes the bounded agreement between the committed declaration, the exact evaluated pull-request state, the complete base-configured check identity, and the observed check result. It does not guarantee code correctness, security, test sufficiency, exhaustive verification, or merge approval, and it does not replace human review.

The engineer can continue the team's normal review process; no ET repair action is required.

## 2. REVIEW REQUIRED

The engineer asks the agent to add ET Verify's first repository check configuration. The evaluated base does not contain `.et-verify/checks.json`, while the pull-request head adds this complete file:

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

`AGENT CLAIMED` has no valid acceptance declaration to bind to a trusted base configuration in this scenario. The head-authored `.et-verify/checks.json` does not become ET-established configuration.

`ET ESTABLISHED` cannot load `.et-verify/checks.json` from the evaluated base, so the integration stops before an ordinary acceptance evaluation. It reports `TRUSTED_CHECK_CONFIG_UNAVAILABLE_AT_EVALUATED_BASE`.

The result is `REVIEW REQUIRED`.

This is the intentional bootstrap state, not an Action crash. It does not establish that the proposed configuration is otherwise good. The engineer reviews the configuration and uses the organization's controlled onboarding or bypass process to merge it. Later pull requests can be evaluated against the configuration once it is present at their merge base.

## 3. BLOCKED

The evaluated base already contains this complete `.et-verify/checks.json`:

```json
{
  "schemaVersion": 1,
  "checks": [
    {
      "checkId": "test",
      "kind": "TEST",
      "command": "NODE",
      "args": ["checks/pass.mjs"],
      "timeoutMs": 5000
    }
  ]
}
```

The engineer asks the agent to change `src/change.js`, but the committed pull-request head also changes `src/undeclared.js`. The agent computes the merge base as `2222222222222222222222222222222222222222` and commits this complete `.et-verify/acceptance.json`:

```json
{
  "schemaVersion": 1,
  "baseCommit": "2222222222222222222222222222222222222222",
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

The complete actual changed-path set is therefore:

- `.et-verify/acceptance.json`
- `src/change.js`
- `src/undeclared.js`

`AGENT CLAIMED` omits `src/undeclared.js` from the exact set and declares the configured check as `PASS`.

`ET ESTABLISHED` observes a passing check but also compares the declaration with the deterministic Git changed-path set. The actual path `src/undeclared.js` is absent from the declared `EXACT_PATH_SET`, so scope is `MISMATCH` and ET Verify emits `acceptance_exact_path_set_mismatch`.

The result is `BLOCKED`.

The contradiction is the path-set mismatch; it is not an inference from missing evidence. If ET Verify cannot compare the required inputs deterministically, the separate issue is `acceptance_exact_path_set_indeterminate` and the result is `REVIEW REQUIRED`, not `BLOCKED`.

The engineer inspects the undeclared change. If it belongs in the pull request, the agent regenerates the declaration with the complete three-path set, commits it, and reruns ET Verify. If it does not belong, the change must be removed before regenerating the declaration.

ET Verify reports the result. Your team decides how that result fits into its review and merge policy.
