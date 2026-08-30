# Review-quality evaluation

## Goal

Give us a fast, credible way to improve amp-reviewbot without pretending an LLM is deterministic or comparing review prose.

For each exact code version, measure:

- whether the final result is `success`, `neutral`, or `failure` at `FAIL_ON=high`;
- whether each known material issue was found;
- how many findings did not match a frozen issue label and therefore need source checking;
- whether severity crossed the right blocking threshold; and
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

`example.json` contains public pull-request context once, followed by one or more exact code versions. It records whether the example is a pilot, human review, or synthetic change, and whether it is used during development or held back. Each version has `knownIssues`. A version with no frozen labels has none. An issue records its cause, failure behavior, severity, category, changed location, and verification evidence.

This handles both benchmark groups:

- a historical pre-fix revision where a non-author human review requested a concrete change and independent evidence confirms the issue; and
- a directly checked baseline revision plus one direct child commit containing a single deliberately introduced issue, normally paired with focused evidence. Source-confirmed baseline issues are repeated unchanged in both versions; the child adds exactly one issue.

Behavioral defects and maintainability advisories are distinct. Substantial duplicated logic can be a medium advisory when it has a concrete divergence cost. Non-idiomatic Go is low and requires official guidance or a dominant repository convention. Neither is described as a behavioral bug.

Approval, merge, draft status, and silence are never labels. A baseline must be checked directly. LLM-checked labels are described as such rather than called human ground truth.

## Run path

```text
private example pack on the trusted machine
  -> verify exact source and calculate changed lines
  -> send every version through the same neutral source-snapshot path with public PR context
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

The trusted runner verifies any delivered Git bundle, then makes a fresh source-only bundle for every target, public or private. Every review receives the same neutral preparation block and reference names. The preparation replaces the checkout's Git repository with a clean repository containing only the exact public base and target history, checks out the exact head, and removes the Git remote. Prior refs, reflogs, and future objects are not retained. Known issues and focused tests do not enter the transfer.

The reviewer is instructed to use only the prepared snapshot and frozen pull-request context. Remote PR activity, reviews, comments, checks, issues, future commits, external documentation, and repository-local instruction files are outside the evidence boundary. Full tool traces are saved and audited for obvious boundary crossings; a flagged run is marked contaminated. This is an auditable restriction, not a claim of perfect network isolation.

The runner rejects a generated source-only transfer over 64 KiB. This keeps repeated reviews bounded and makes an oversized synthetic example a clear pack error instead of an unexpectedly slow or expensive run.

## Account boundary

The example pack stays with the trusted account. The trusted process and matching orbs use the authenticated local Amp CLI.

By default, review orbs use that same CLI login. This is convenient for a smoke run but does not prove that the reviewer is isolated from the answers. For blind evidence, set one optional environment variable:

- `AMP_EVAL_REVIEWER_API_KEY`: separate review account, used only by the review child process.

When set, the runner validates the key and stores only a hash of its Amp user ID. The review child gets a new empty home directory and an allowlisted environment, while matching continues through the local login. `--project` selects the review account's source project. The runner cannot compare a stored CLI login with the supplied key, so the operator must confirm that the accounts differ and that the review account cannot read the example project.

`AMP_API_KEY` is rejected for eval runs so it cannot silently replace the local CLI login. Two projects owned by the same account are not an isolation boundary.

## Repeated runs

Run each version independently three times in reproducibly shuffled repeat blocks. Each block contains every selected version once, and the artifact records the random seed and exact start order. Do not average review text. Score each run as facts such as “issue found” and “right final result,” then aggregate at the pull-request seed.

Use a rule chosen before seeing results:

- 3 of 3 seed votes: provisional pass for this small set;
- 2 of 3 seed votes: unstable;
- 0 or 1 of 3: needs work on that example;
- at five runs, require at least 4 of 5.

Never replace a failed run or add runs only where the preferred version is behind. When comparing two reviewer versions, run both over the same examples and repeat count close together in time.

For a synthetic seed, one seed vote matches only when the baseline and introduced version both match in the same repeat. A baseline with source-confirmed inherited labels is judged against those labels rather than being called clean.

Model matching is also non-deterministic. It starts only after all reviewer calls have finished and a private completed-review checkpoint has been saved. It uses a separate timeout, so matching latency or interruption cannot erase completed reviews. Two independent high-mode calls check each known issue against the retained findings. A third is used only when the first two disagree. Identical checks are cached. The saved run records the votes and their complete prompt, schema, SDK, mode, model information, and phase timing.

## What the report means

The main report answers:

- did every review finish;
- did versions with no frozen issues avoid clean alerts;
- was each known issue found;
- was the final response appropriately urgent; and
- were repeated runs stable?

The saved JSON keeps exact commits, context, changed lines, every complete review prompt, full SDK tool traces, model IDs, raw output, filtered findings, conclusions, matching votes, code hashes, separate review/matching timing, execution order, evidence-boundary audit, and errors. Re-reading a saved report makes no model or network calls. The artifact is private and potentially sensitive.

If matching fails after reviews finish, `npm run eval -- finish RUN.json` retries only the missing matches through the local CLI login. It writes a new file, preserves the original review evidence and timing, and records the exact hash of the source file. It does not rerun reviews or use the separate review-account key.

One finding can match at most one known issue, and one known issue can be counted at most once per review. Extra findings stay visible as unmatched findings that need source checking. Do not call the matched-finding fraction precision. A conclusion receives frozen-label credit only when all known issues for that version were found at the correct side of the blocking threshold.

## Scientific limits

The first open pack is a regression set for iteration. It is not a representative population sample.

The pilot remains separate because its outcomes have already been observed. The frozen benchmark adds 60 different source pull requests: 30 exact human-reviewed revisions and 30 baseline/synthetic pairs. Ten from each group are held back before any review run. Source-PR membership, labels, issue cards, and rejection reasons freeze before tuning.

Because LLMs create and check most labels, report agreement with the labeled examples, not “true accuracy.” Audit every unmatched finding before classifying it. If a review finds a real bug missing from the pack, repair the baseline label (and repeat it in both synthetic versions) rather than count the finding as a false alarm. Keep this later source adjudication separate from the frozen metrics.

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
- A local Git fixture proves source commits, bundles, changed lines, and issue anchors are checked. Synthetic issues must be introduced by one direct child commit and point to a line changed by that commit; inherited baseline cards must be identical in both versions.
- Every generated review source bundle contains one target ref and no known-bug or witness data; every version receives the same neutral preparation shape.
- The runner uses local CLI authentication by default; when a review key is supplied, the review child receives only that key and basic connection settings.
- Production prompts are unchanged when no eval source preparation is supplied.
- Saved runs reject altered corpus evidence, invalid finding indexes, conclusions that do not follow from raw production output, prompt-hash or phase-timing drift, missing full prompts/traces, and execution-order drift.
- Interrupted matching can finish into a new traceable result without changing or rerunning saved reviews.
- One finding cannot earn recall for two known issues.
- A live one-sample smoke run succeeds in the review account's source project before the full repeated run.
