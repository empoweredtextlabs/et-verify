# EmpoweredText Agent Work Protocol

Status: experimental and non-normative. This document describes an
operating method for delegating software changes to coding agents. It
confers no verification authority. The ET Verify contract documents —
the [coding-agent instruction](AGENT_INSTRUCTIONS.md), the
[acceptance declaration shape](../README.md#acceptance-declaration), and
the [V1 GitHub Action reference](GITHUB_ACTION_V1.md) — remain
authoritative wherever this document and they appear to differ.

A bounded operating sequence for delegating software changes to a coding
agent when the completion report will be independently checked.

Five stages:

DEFINE → EXECUTE → DECLARE → VERIFY → ADJUDICATE

Each stage has one copyable prompt. The prompts are provider-agnostic:
they work in any coding agent that accepts instructions.

## The separation law

The layer that helps an agent work never decides whether the work passed.

This protocol organizes the work. ET Verify — a separate GitHub Action,
pinned to an exact public commit, reading trusted configuration from the
evaluated merge base — independently establishes the verification result.
Your team decides what the result is worth. No prompt in this document
carries verification authority, changes the evidence ET Verify
establishes, or changes the meaning of its result.

## What these prompts are

Convenience wrappers around the public contract. The authoritative
sources remain:

- [`AGENT_INSTRUCTIONS.md`](AGENT_INSTRUCTIONS.md) — the coding-agent instruction
- [README: Acceptance declaration](../README.md#acceptance-declaration) — the declaration shape
- [`GITHUB_ACTION_V1.md`](GITHUB_ACTION_V1.md) — the full execution and authority boundary
- [`QUICKSTART.md`](QUICKSTART.md) — installation and setup

The prompts defer to those authoritative sources. Where this protocol
repeats contract details for operating convenience, the authoritative
sources control if anything differs. This document does not create a
second normative contract.

## Non-dominance

This protocol wraps the engineering conventions a repository already
uses; it does not replace them. Existing agent instructions, repository
structure, CI, checks, review policy, and team workflow remain
authoritative in their own domains. The protocol introduces only the
minimum structure needed to define agent work, preserve truthful
completion claims, support independent verification, and hand
unresolved judgment back to people. Deeper integration should be earned
through demonstrated usefulness, not required as a condition of
adoption.

---

## Stage 1 — DEFINE the job

Before any edit, freeze what the job is. Ambiguity discovered after
implementation becomes scope drift; ambiguity surfaced now is just a
question.

> You are starting a bounded software-change job. Before editing
> anything, establish and state: the requested outcome; the path scope
> authorized by the human request, an accepted plan, or a repository
> instruction — if no authorized scope exists, propose one and ask
> before editing; the current repository state relevant to the change; the
> checks configured in `.et-verify/checks.json` at the evaluated merge
> base, if present; the evidence you will need to support your
> completion report; and any ambiguity that prevents a deterministic
> reading of this job. Ask about the ambiguities now. Do not expand
> scope because adjacent work looks useful. Your completion report will
> be independently checked against the resulting work.

## Stage 2 — EXECUTE under scope

> Implement the job within the frozen scope from the definition step.
> As you work, preserve the distinction between what you observed, what
> you changed, what you tested, and what you infer. If completing the
> job appears to require touching paths outside the authorized scope,
> stop and report instead of silently expanding. Do not weaken, skip,
> or reconfigure existing checks to make your work pass them.

## Stage 3 — DECLARE the completion

The declaration is a claim, not evidence. ET Verify produces the trusted
evidence itself; the declaration's job is to be exactly true.

> The work is complete. Now prepare `.et-verify/acceptance.json` for
> this pull request by following the ET Verify coding-agent instruction
> in this repository's agent configuration (`AGENTS.md` or equivalent).
> Independently reconstruct what actually changed — do not work from
> memory of what you intended. Compute the evaluated `baseCommit` with
> `git merge-base` from complete history. Declare the complete exact
> final changed-path set, including `.et-verify/acceptance.json`
> itself. Declare every check configured at the evaluated base exactly
> once, with its configured `checkId` and `kind`, and declare only
> results you actually established. Do not invent passing checks, omit
> changed paths, or retrofit claims to look successful. Before writing
> the file, show me the declaration you intend to commit and the
> evidence supporting each claim. If any configured check cannot
> truthfully be declared `PASS`, do not invent a passing result to make
> the declaration schema-valid. Stop and report the observed result to
> the human. Write the acceptance declaration only when every required
> declaration claim can be made truthfully.

## Stage 4 — VERIFY (ET Verify's stage, not the agent's)

Nothing to prompt. The supplied required workflow runs ET Verify at the
exact pull-request head. It reads trusted configuration from the
evaluated merge base, runs the configured checks itself, compares the
declaration against repository state and trusted evidence, and reports
one of three results with the evidence split into `AGENT CLAIMED` and
`ET ESTABLISHED`.

If the result needs interpreting, or the agent needs to respond to it:

> Read this ET Verify result using the distinction between
> `AGENT CLAIMED` and `ET ESTABLISHED`. State exactly why the result is
> `ACCEPTED`, `REVIEW REQUIRED`, or `BLOCKED`, naming the specific
> issue codes present. Distinguish missing evidence from an established
> contradiction. Then classify the cause before proposing anything:
> defective implementation, defective declaration, stale `baseCommit`,
> scope mismatch, missing configuration, or intentional bootstrap
> behavior. Propose the smallest legitimate repair for that cause. Do
> not change check or workflow policy merely to make an unfavorable
> verification result pass. A policy or configuration change is a
> separate human decision, not a repair to the current result. Do not
> treat `ACCEPTED` as proof the code is correct or secure, and do not
> assume ET Verify controls whether this merges.

## Stage 5 — ADJUDICATE (the human's stage)

The protocol ends by handing the remaining judgment to a person. To
compress the job for the operator:

> Summarize this job for the human operator in five parts: what was
> requested; what actually changed; what the agent's declaration
> claims; what ET Verify established, including its result state and
> any issue codes; and the judgment calls that remain open. Do not
> soften discrepancies between the claims and the established result.
> End with the specific decision the human needs to make.

---

## Setup prompt (one-time, per repository)

> Add the ET Verify public alpha to this repository by following its
> public Quickstart exactly
> (github.com/empoweredtextlabs/et-verify — docs/QUICKSTART.md). Use
> the supplied required-workflow template rather than writing a new
> workflow. Keep the immutable action pin
> `empoweredtextlabs/et-verify@474a1d79599a714ccb2cac28a0b34c1444ad86c7`
> unchanged. Configure only checks that correspond to real commands in
> this repository, inside the bounded `checks.json` contract. Copy the
> coding-agent instruction into `AGENTS.md` or the equivalent agent
> configuration. Do not weaken existing CI or branch policy. Expect the
> first configuration pull request to return `REVIEW REQUIRED` — that
> is intentional bootstrap behavior, and a human merges the bootstrap
> change through your normal controlled process. Before modifying
> anything, show me the exact files you would add or change and why
> each is required.

---

## Boundaries

- `ACCEPTED` means the declaration was supported by the trusted
  evidence ET Verify checks. It is not a correctness, security, or
  sufficiency claim, and it does not replace review.
- These prompts are intended to help agents structure truthful
  completion claims. They are
  not what makes the check trustworthy — ET Verify evaluates the
  declaration against trusted evidence regardless of how the
  declaration was written.
- This protocol is a working method, not a measured result. No claim
  is made that it produces better outcomes; whether it does is an open
  question a team can evaluate against its own pull requests.
