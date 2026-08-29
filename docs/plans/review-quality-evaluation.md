# Review-quality evaluation

## Goal

Give us a fast, credible way to improve amp-reviewbot without pretending an LLM is deterministic or comparing review prose.

For each exact code version, measure:

- whether the final result is `success`, `neutral`, or `failure` at `FAIL_ON=high`;
- whether each known material bug was found;
- how many findings did not match a known bug;
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

`example.json` contains public pull-request context once, followed by one or more exact code versions. Each version has `knownIssues`. A clean version has none. A bug records only its cause, failure behavior, severity, changed location, and verification evidence.

This handles both kinds of examples:

- deliberately introduced bugs, normally paired with a focused test; and
- bugs found in a historical human review, after a stronger model checks the review claim against the exact code.

Approval, merge, draft status, and silence are never labels. A clean example must be checked directly. LLM-checked labels are described as such rather than called human ground truth.

## Run path

```text
private example pack on the trusted machine
  -> verify exact source and calculate changed lines
  -> send only source and public PR context to a fresh review orb
  -> parse and filter with production code
  -> use trusted matching calls to compare findings with known bugs
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

If a deliberately changed commit is not public, the trusted runner verifies the pack's Git bundle and makes a second bundle containing only the source history needed for that target. Those source-only bytes go in the trusted source-preparation section of the review prompt. Known bugs and focused tests do not.

## Account boundary

The example pack stays with the trusted account. Blind reviews use a separate Amp account that can access the source project but not the example pack.

The local command uses two environment variables:

- `AMP_API_KEY`: trusted account, used for matching;
- `AMP_EVAL_REVIEWER_API_KEY`: work account, used only by the blind-review child process.

Before reading the pack, the runner resolves both keys to stable Amp user IDs and rejects a match. It stores only hashes of those IDs in the run evidence. The review child then gets a new empty home directory and an allowlisted environment. `--project` selects the review account's source project. We do not switch the global Amp CLI login and we never put a key in a command argument.

This is safe only when the keys belong to genuinely different accounts and the work account cannot read the private example project. Two projects owned by the same account are not an isolation boundary.

## Repeated runs

Run each version independently three times. Do not average review text. Score each run as facts such as “bug found” and “right final result,” then report counts such as 2 of 3.

Use a rule chosen before seeing results:

- 3 of 3: provisional pass for this small set;
- 2 of 3: unstable, so run both old and new reviewers five times;
- 0 or 1 of 3: needs work on that example;
- at five runs, require at least 4 of 5.

Never replace a failed run or add runs only where the preferred version is behind. When comparing two reviewer versions, run both over the same examples and repeat count close together in time.

Model matching is also non-deterministic. Two independent high-mode calls check each known bug against the retained findings. A third is used only when the first two disagree. Identical checks are cached. The saved run records the votes and their prompt, schema, SDK, mode, and model information when available.

## What the report means

The main report answers:

- did every review finish;
- did clean code avoid false alarms;
- was each known bug found;
- was the final response appropriately urgent; and
- were repeated runs stable?

The saved JSON keeps exact commits, context, changed lines, raw output, filtered findings, conclusions, matching votes, code and prompt hashes, timing, and errors. Re-reading a saved report makes no model or network calls.

One finding can match at most one known bug, and one known bug can be counted at most once per review. Extra findings stay visible and reduce finding precision. A correct failure conclusion receives “right response” credit only when all known bugs for that version were found at the correct side of the blocking threshold.

## Scientific limits

The first open pack is a regression set for iteration. It is not a representative benchmark.

A useful first pack has 3–5 varied historical changes, each with a clean version, a smaller bug, and a serious bug. That is enough to catch regressions in the loop. A more credible internal benchmark needs roughly 20–30 source pull requests across different subsystems and failure types, frozen before tuning, with part held back until a candidate is chosen.

Because LLMs create and check most labels, report agreement with the labeled examples, not “true accuracy.” Periodically spot-check a sample of labels and disputed matches. If a review finds a real bug missing from the pack, fix the label rather than count the finding as a false alarm.

## First run

1. Keep the example pack private under the trusted account.
2. Confirm the work account cannot clone that project.
3. Set the trusted and review account keys securely in the local environment.
4. Run `npm run eval -- check /path/to/review-eval-pack`.
5. Run one sample with `--project REVIEW_PROJECT --samples 1` to prove checkout, source preparation, and account access.
6. Inspect the saved evidence for label leakage and production parity.
7. Run the full first example three times.
8. Add 2–4 different Agent examples before tuning the reviewer against the set.

## Verification

- Normal typecheck, tests, and build pass without live Amp calls.
- A local Git fixture proves source commits, bundles, changed lines, and issue anchors are checked.
- The generated review source bundle contains one target and no known-bug or witness data.
- The runner rejects two keys belonging to the same Amp user, and the review child receives only its dedicated API key and basic connection settings.
- Production prompts are unchanged when no eval source preparation is supplied.
- Saved runs reject altered corpus evidence, invalid finding indexes, and conclusions that do not follow from raw production output.
- One finding cannot earn recall for two known bugs.
- A live one-sample smoke run succeeds in the review account's source project before the full repeated run.
