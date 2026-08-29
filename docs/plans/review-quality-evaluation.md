# Review-quality evaluation

## Goal

Give us a fast, credible way to improve amp-reviewbot without pretending an LLM is deterministic or comparing review prose.

For each exact code version, measure:

- whether the final result is `success`, `neutral`, or `failure` at `FAIL_ON=high`;
- whether each known material issue was found;
- how many findings did not match a known issue;
- whether severity crossed the right blocking threshold; and
- how often repeated fresh reviews agree.

## Smallest useful design

Keep the runner in amp-reviewbot and examples in a separate repository.

Each historical pull request is one directory:

```text
examples/
  example-id/
    example.json
    commits.bundle       # optional source-only commits
    witnesses/           # optional focused tests
```

`example.json` contains public pull-request context once, followed by one or more exact code versions. It records whether the example is a pilot, human review, or synthetic change, and whether it is used during development or held back. Each version has `knownIssues`. A clean version has none. An issue records its cause, failure behavior, severity, category, changed location, and verification evidence.

This handles both benchmark groups:

- a historical pre-fix revision where a non-author human review requested a concrete change and independent evidence confirms the issue; and
- a directly checked clean revision plus one direct child commit containing a single deliberately introduced issue, normally paired with focused evidence.

Behavioral defects and maintainability advisories are distinct. Substantial duplicated logic can be a medium advisory when it has a concrete divergence cost. Non-idiomatic Go is low and requires official guidance or a dominant repository convention. Neither is described as a behavioral bug.

Approval, merge, draft status, and silence are never labels. A clean example must be checked directly. LLM-checked labels are described as such rather than called human ground truth.

## Run path

```text
private example pack on the trusted machine
  -> verify exact source and calculate changed lines
  -> send only source and public PR context to a fresh review orb
  -> parse and filter with production code
  -> use trusted matching calls to compare findings with known issues
  -> calculate and save counts
```

Production and evaluation share:

- the exact `base...head` target;
- frozen title, description, and branch names;
- a fresh Amp orb in `medium` mode;
- the production prompt and embedded two-pass review method;
- retry and JSON parsing behavior; and
- changed-line filtering and conclusion calculation.

Evaluation does not call GitHub, publish Checks, use production queueing, or give credentials to a review orb.

If a deliberately changed commit is not public, the trusted runner verifies the pack's Git bundle and makes a second bundle containing only the source history needed for that target. Those source-only bytes go in the trusted source-preparation section of the review prompt. Known issues and focused tests do not.

The runner rejects a generated source-only transfer over 64 KiB. This keeps repeated reviews bounded and makes an oversized synthetic example a clear pack error instead of an unexpectedly slow or expensive run.

## Account boundary

The example pack stays with the trusted account. The trusted process and matching orbs use the authenticated local Amp CLI.

By default, review orbs use that same CLI login. This is convenient for a smoke run but does not prove that the reviewer is isolated from the answers. For blind evidence, set one optional environment variable:

- `AMP_EVAL_REVIEWER_API_KEY`: separate review account, used only by the review child process.

When set, the runner validates the key and stores only a hash of its Amp user ID. The review child gets a new empty home directory and an allowlisted environment, while matching continues through the local login. `--project` selects the review account's source project. The runner cannot compare a stored CLI login with the supplied key, so the operator must confirm that the accounts differ and that the review account cannot read the example project.

`AMP_API_KEY` is rejected for eval runs so it cannot silently replace the local CLI login. Two projects owned by the same account are not an isolation boundary.

## Repeated runs

Run each version independently three times. Do not average review text. Score each run as facts such as “issue found” and “right final result,” then report counts such as 2 of 3.

Use a rule chosen before seeing results:

- 3 of 3: provisional pass for this small set;
- 2 of 3: unstable, so run both old and new reviewers five times;
- 0 or 1 of 3: needs work on that example;
- at five runs, require at least 4 of 5.

Never replace a failed run or add runs only where the preferred version is behind. When comparing two reviewer versions, run both over the same examples and repeat count close together in time.

Model matching is also non-deterministic. Two independent high-mode calls check each known issue against the retained findings. A third is used only when the first two disagree. Identical checks are cached. The saved run records the votes and their prompt, schema, SDK, mode, and model information when available.

## What the report means

The main report answers:

- did every review finish;
- did clean code avoid false alarms;
- was each known issue found;
- was the final response appropriately urgent; and
- were repeated runs stable?

The saved JSON keeps exact commits, context, changed lines, raw output, filtered findings, conclusions, matching votes, code and prompt hashes, timing, and errors. Re-reading a saved report makes no model or network calls.

If matching fails after reviews finish, `npm run eval -- finish RUN.json` retries only the missing matches through the local CLI login. It writes a new file, preserves the original review evidence and timing, and records the exact hash of the source file. It does not rerun reviews or use the separate review-account key.

One finding can match at most one known issue, and one known issue can be counted at most once per review. Extra findings stay visible and reduce finding precision. A correct failure conclusion receives “right response” credit only when all known issues for that version were found at the correct side of the blocking threshold.

## Scientific limits

The first open pack is a regression set for iteration. It is not a representative population sample.

The pilot remains separate because its outcomes have already been observed. The frozen benchmark adds 60 different source pull requests: 30 exact human-reviewed revisions and 30 clean/synthetic pairs. Ten from each group are held back before any review run. Source-PR membership, labels, issue cards, and rejection reasons freeze before tuning.

Because LLMs create and check most labels, report agreement with the labeled examples, not “true accuracy.” Periodically spot-check a sample of labels and disputed matches. If a review finds a real bug missing from the pack, fix the label rather than count the finding as a false alarm.

## First run

1. Keep the example pack private under the trusted account.
2. Confirm the work account cannot clone that project.
3. Log the local Amp CLI into the trusted account and, for blind reviews, set a separate `AMP_EVAL_REVIEWER_API_KEY`.
4. Run `npm run eval -- check /path/to/review-eval-pack`.
5. Run one sample with `--project REVIEW_PROJECT --samples 1` to prove checkout, source preparation, and account access.
6. Inspect the saved evidence for label leakage and production parity.
7. Run the full first example three times.
8. Freeze the benchmark selection and holdout before tuning the reviewer against it.

Normal `run` commands select development examples and exclude holdouts. After choosing a candidate reviewer, use `--split holdout` to run only the frozen holdout.

## Verification

- Normal typecheck, tests, and build pass without live Amp calls.
- A local Git fixture proves source commits, bundles, changed lines, and issue anchors are checked. Synthetic issues must be introduced by one direct child commit and point to a line changed by that commit.
- The generated review source bundle contains one target and no known-bug or witness data.
- The runner uses local CLI authentication by default; when a review key is supplied, the review child receives only that key and basic connection settings.
- Production prompts are unchanged when no eval source preparation is supplied.
- Saved runs reject altered corpus evidence, invalid finding indexes, and conclusions that do not follow from raw production output.
- Interrupted matching can finish into a new traceable result without changing or rerunning saved reviews.
- One finding cannot earn recall for two known issues.
- A live one-sample smoke run succeeds in the review account's source project before the full repeated run.
