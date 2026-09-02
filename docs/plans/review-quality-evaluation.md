# Review-quality evaluation

## Goal

Give us a fast, credible way to improve amp-reviewbot without pretending an LLM is deterministic or comparing review prose.

**Status:** example validation, realistic review runs, complete evidence saving, scoring, and offline reports are implemented. The reviewer can use public research, as it can in production, but must use only our supplied copy of the target repository and must not inspect the target pull request. We check the saved trace for obvious breaches, but this is not a secure sandbox.

For each exact code version, measure:

- whether the final result is `success`, `neutral`, or `failure` at `FAIL_ON=high`;
- whether each known material issue was found;
- how many findings did not match a recorded issue and therefore need source checking;
- whether the issue had the right urgency—high findings block, lower severities do not; and
- how often repeated fresh reviews agree.

## Smallest useful design

Keep the runner in amp-reviewbot and examples in a separate repository.

Each source pull request is one directory:

```text
examples/
  example-id/
    example.json
    commits.bundle       # optional source-only commits
    witnesses/           # optional focused tests
```

`example.json` contains public pull-request context once, followed by one or more exact code versions. It records whether the example is a pilot, human review, or deliberately broken change, and whether it is used during development or held back. Each version has a `knownIssues` list. An issue records its cause, visible failure, severity, category, changed location, and verification evidence.

This handles both example groups:

- a historical pre-fix revision where a non-author human review requested a concrete change and independent evidence confirms the issue; and
- a directly checked baseline plus one child commit containing exactly one deliberately introduced issue, normally paired with focused evidence. Any issue already present in the baseline is recorded in both versions, although its source line may move; the child adds exactly one issue.

Behavioral defects and maintainability advisories are distinct. Substantial duplicated logic can be a medium advisory when it has a concrete divergence cost. Non-idiomatic Go is low and requires official guidance or a dominant repository convention. Neither is described as a behavioral bug.

Approval, merge, draft status, and silence do not prove that a version is correct. A baseline must be checked directly. When an LLM checked an issue, say so rather than presenting it as certain human judgment.

## Run path

The enabled run path is:

```text
private example pack on the trusted machine
  -> verify exact source and calculate changed lines
  -> send every version through the same prepared-source path with public PR context
  -> parse and filter with production code
  -> compare findings with recorded issues using the trusted account
  -> calculate and save counts
```

Production and evaluation use the same:

- the exact `base...head` target;
- title, description, and branch names captured before the run;
- a fresh Amp orb in `medium` mode;
- the production prompt and embedded two-pass review method;
- retry and JSON parsing behavior; and
- changed-line filtering and conclusion calculation.

The runner does not publish GitHub Checks, use the production queue, or give private example credentials to a review orb.

The trusted runner verifies the input commits and creates a fresh source-only Git bundle for every review. Each review starts in a clean orb with no Amp project and an empty workspace. The first command creates a repository containing only the history needed for the exact base and reviewed commits, checks out the reviewed commit, and removes the remote. Project setup, repository instructions, other refs, reflogs, later objects, recorded issues, and focused tests are not transferred.

The reviewer runs the complete setup block as its first successful tool call; any failed command stops the block. It then uses only that copy of the target repository. It must not inspect the target pull request through GitHub pages or APIs, nor clone, fetch, or inspect another copy of the target repository. Public documentation, package registries, dependencies, other repositories, and delegated research that follows the same rule are allowed.

The saved trace is checked for four things: the source setup ran first and completed before other tools ran; the review used the chosen Amp mode and did not explicitly move shell commands outside its prepared workspace; research tools did not name the target pull request or repository; and the prepared repository did not run `git fetch` or `git pull`. Amp reports the trusted machine's path during startup and the mounted orb path in tool calls, so the first shell command establishes the workspace used by later checks. A breach makes the run invalid for comparison.

These checks are deliberately simple. A reviewer trying to cheat could hide a lookup in another process. Blocking all public access would make the test unlike a real review, so we accept that risk. The results measure a reviewer following the instructions in a realistic environment; they do not prove resistance to deliberate cheating.

The runner rejects a generated source-only transfer over 64 KiB. This keeps repeated reviews bounded and makes an oversized synthetic example a clear pack error instead of an unexpectedly slow or expensive run.

## Separate reviewer account

The example pack stays with the trusted account. The trusted process and matching orbs use the authenticated local Amp CLI. Reviews require a separate identity:

- `AMP_EVAL_REVIEWER_API_KEY`: separate review account, used only by the review child process.

The runner validates that key and stores only a hash of its Amp user ID. The review process gets a new empty home directory and only a small fixed list of environment variables. Comparing findings with recorded issues continues through the trusted local login. Before a run, the operator must confirm that the review identity cannot access the private example pack.

`AMP_API_KEY` is rejected so it cannot silently replace the local CLI login. Putting the examples and reviewer in two projects owned by the same account does not separate their access.

## Repeated runs

Run each version independently three times in reproducibly shuffled groups. Each group contains every selected version once, and the result file records the random ordering value and exact start order. Do not compare or average prose. Reduce each review to facts such as “issue found” and “right final result,” then combine versions belonging to the same source pull request.

Use a rule chosen before seeing results:

- 3 of 3 repeats: provisional pass for this small set;
- 2 of 3 repeats: unstable;
- 0 or 1 of 3: needs work on that example;
- at five runs, require at least 4 of 5.

Never replace a failed run or add runs only where the preferred version is behind. When comparing two reviewer versions, run both over the same examples and repeat count close together in time.

For a synthetic before-and-after pair, one repeat passes only when the reviewer gets both versions right. A baseline with a source-confirmed existing issue is checked against that issue rather than being called clean.

Deciding whether a finding describes a recorded issue also uses a model and can vary. These checks start only after every review has finished and the completed reviews have been saved privately. They have a separate timeout, so a slow or interrupted check cannot erase review results. Two independent calls in Amp's `high` mode compare each recorded issue with the review findings. A third call breaks a disagreement. Identical checks are reused. The saved result includes every decision and the prompt, response format, SDK, CLI, mode, any model ID Amp reports, and timing behind it.

Amp's normal agent API selects a mode, not an exact model. A plugin-defined agent could pin a model, but it would no longer be the built-in `medium` agent used by the production reviewer. We keep production parity: the run records exact SDK and CLI versions, checks the mode reported by each review, and records exact model IDs when Amp supplies them. An empty model list means Amp did not report the ID. Comparisons should be run close together and should not claim exact-model reproducibility unless the recorded model IDs match.

## What the report means

The main report answers:

- did every review finish;
- did versions with no recorded issues avoid alerts;
- was each known issue found;
- was the final response appropriately urgent; and
- were repeated runs stable?

Saved JSON keeps the exact commits, context, changed lines, prompts, full tool traces, Amp mode, exact SDK and CLI versions, any model IDs Amp reports, raw output, filtered findings, conclusions, matching decisions, code hashes, separate timing, execution order, review-rule identifier, trace checks, and errors. Re-reading it makes no model or network calls. New reports say `PUBLIC RESEARCH ALLOWED`; a rule breach produces `INVALID FOR COMPARISON`. Older files are labeled `HISTORICAL RESULT`. The file is private and potentially sensitive.

If matching fails after reviews finish, `npm run eval -- finish RUN.json` retries only the missing matches through the local CLI login. It writes a new file, preserves the original review evidence and timing, and records the exact hash of the source file. It does not rerun reviews or use the separate review-account key.

One finding can match at most one recorded issue, and one issue can be counted at most once per review. Extra findings stay visible until the source is checked. Do not call the percentage that matched recorded issues “precision,” because extra findings have not yet been proven wrong. A response counts as correct only when it finds every recorded issue for that version and uses the right urgency: high findings block, lower severities do not.

## Scientific limits

The first open pack is for catching quality regressions during development. It is not a representative sample of all pull requests.

The pilot remains separate because its outcomes have already been seen. The main set has 60 different source pull requests: 30 exact human-reviewed versions and 30 baseline/synthetic pairs. Ten from each group are held back before any review run. Example membership, recorded issues, and rejection reasons are fixed before tuning starts.

Because LLMs create and check most recorded issues, report agreement with the examples, not “true accuracy.” Check every unmatched finding against the source before classifying it. If the reviewer finds a real issue missing from an example, fix the example (and record the issue in both versions of a synthetic pair) rather than call the finding a false alarm. Keep this later source check separate from the original counts.

## Before a run

1. Keep the example pack private and confirm the separate reviewer identity cannot access it.
2. Validate that each supplied repository has only the history needed for its base and reviewed commits, and no remote.
3. Fix the example set, development/held-back split, prompts, mode, repeat count, and matching rules before running a development sample.
4. Ask for explicit confirmation before starting any reviewer or matching model calls, including smoke, development, holdout, or `finish`.

## Verification

- Normal typecheck, tests, and build pass without live Amp calls.
- A local Git fixture proves source commits, bundles, changed lines, and issue anchors are checked. Synthetic issues must be introduced by one direct child commit and point to a line changed by that commit; inherited baseline semantics must be identical while source lines may move.
- Every generated review source bundle contains one target ref and no known-bug or witness data; every version receives the same neutral preparation shape.
- The runner uses local CLI authentication by default; when a review key is supplied, the review child receives only that key and basic connection settings.
- Production prompts are unchanged when no eval source preparation is supplied.
- Saved runs reject altered example evidence, invalid finding indexes, conclusions that do not follow from raw production output, changed prompts or schemas, missing full prompts or traces, inconsistent timing, and changed execution order. They preserve the original trace check while reports also apply the current check, so improved detection does not make an unchanged file unreadable.
- Interrupted matching can finish into a new traceable result without changing or rerunning saved reviews.
- One finding cannot earn recall for two known issues.
- A run requires a separate review-account key and records the exact review rules, Amp mode, SDK version, and CLI version it used.
- Public dependency and documentation research is allowed. If the trace shows access to the target pull request or another copy of the target repository, the run is invalid for comparison.
