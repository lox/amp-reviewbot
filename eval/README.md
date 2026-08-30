# Review evaluation

This evaluation answers four questions:

1. Does the reviewer leave a version with no frozen issues alone?
2. Does it find each known issue?
3. Does it use the right urgency?
4. Does it give the same answer across repeated reviews?

The answers are counts, not prose comparisons. A saved run keeps the exact evidence behind those counts.

## Example pack

Keep real examples in a separate repository. The smallest useful layout is:

```text
examples/
  example-id/
    example.json
    commits.bundle          # only when a code version is not in public history
    witnesses/              # focused tests; optional
```

[`example.json`](example.json) shows the format. It records the exact public pull-request context, whether the example is a pilot, human review, or synthetic change, and whether it is used during development or held back. Each version has a commit and `knownIssues`. A version with no frozen labels has an empty list. An issue records its cause, visible effect, severity, changed line, category, and how it was checked.

A human-review example has one exact pre-fix version. A synthetic example has a checked baseline and one direct child commit with a single introduced issue. If source inspection finds a real issue in the baseline, both versions repeat that issue's semantic card while each version records its exact source line; the child adds exactly one issue. The introduced issue's labeled line must be changed by that child commit, not merely by the original pull request. Behavioral defects and maintainability advisories are recorded separately; duplication and non-idiomatic Go are advisories rather than behavioral bugs.

The runner calculates changed lines from the exact Git diff. It does not store a second hand-written copy. It also calculates the expected `success`, `neutral`, or `failure` result from issue severity at `FAIL_ON=high`.

## Keep reviews blind

The command uses the account from your authenticated local Amp CLI for trusted matching. By default it also uses that account for review orbs:

```sh
amp login
npm run eval -- run /path/to/review-eval-pack --project REVIEW_PROJECT
```

For account-isolated reviews, provide a key from a separate account that can access the source project but cannot access the example pack:

```sh
export AMP_EVAL_REVIEWER_API_KEY="separate-review-account-key"
```

`AMP_EVAL_REVIEWER_API_KEY` is passed only to a child process with an empty home directory. The trusted process and matching orbs continue to use the local CLI login. The runner validates the review key and stores only a hash of its Amp user ID, but cannot compare it with the CLI's stored login. Confirm that they are different accounts before relying on the run as blind evidence.

Do not set `AMP_API_KEY`; the command rejects it so the trusted side cannot silently override the local CLI login. The project is selected by `--project`. Without the optional review key, the run records that both roles used the local CLI and does not claim an account boundary.

The reviewer receives only:

- the exact base and head commits;
- the public pull-request title, description, and branch names;
- the production review instructions; and
- the same neutral source-snapshot setup for every version.

It never receives `knownIssues`, focused tests, or the path to the pack. The trusted process checks every bundle and commit ID before any reviews start. Each review replaces the checkout's Git repository with a clean one containing only the exact public base and source-only target history, checks out the exact head, and removes the Git remote. Prior refs, reflogs, and future objects are not retained. The prompt limits evidence to that snapshot and the frozen pull-request context; it forbids remote PR pages, reviews, comments, checks, issues, future commits, and external documentation.

The saved tool trace is checked for obvious boundary crossings such as web tools, `gh`, `curl`, unapproved Git network commands, future-ref or reflog recovery, or repository-local instruction files. A flagged run is reported as `CONTAMINATED`, not silently scored as clean evidence. This audit is useful evidence, not a perfect network sandbox.

Source-only transfers over 64 KiB are rejected so one source revision cannot make every repeated review unexpectedly large or expensive. Keep each synthetic change focused.

## Commands

Check the pack's files without starting reviews:

```sh
npm run eval -- check /path/to/review-eval-pack
```

Run development code versions three times, with at most two reviews running at once. Holdout examples are excluded by default:

```sh
npm run eval -- run /path/to/review-eval-pack \
  --project REVIEW_PROJECT \
  --samples 3 \
  --concurrency 2 \
  --order-seed RECORDED_RANDOM_SEED
```

After choosing a candidate reviewer, run only the held-back examples explicitly:

```sh
npm run eval -- run /path/to/review-eval-pack \
  --project REVIEW_PROJECT \
  --split holdout \
  --samples 3 \
  --concurrency 2
```

Before the first review, this command validates any review key, fetches the public source, verifies any source bundle, checks every commit, calculates changed lines, and rejects a known issue that does not point to a changed line. For a synthetic example, it also checks that the introduced version is one commit on top of the baseline, repeats every baseline issue without semantic changes, adds exactly one issue, and changes that issue's labeled line. An inherited issue's line may move with the source.

Every review then uses a fresh private Amp orb and the same prompt builder, two-pass review method, JSON parser, changed-line filter, and conclusion calculation as production. Review tasks run in reproducibly shuffled blocks: every version gets run once before the next repeat block begins. The artifact records the seed and exact start order.

Only after all reviews finish does the runner save a private checkpoint, then the trusted account compares retained findings with frozen issue labels. It uses two independent high-mode checks and a third only when they disagree. Review and matching timeouts are separate, so a slow matcher cannot turn a completed review into an operational review error. Use `--timeout-minutes` for reviews and `--judge-timeout-minutes` for each comparison. If matching is interrupted, the output path retains the completed-review checkpoint for `finish`.

The command prints progress and saves complete results under `.eval-runs/`. Read a saved result without making network or model calls:

```sh
npm run eval -- report .eval-runs/RUN.json
```

If reviews finish but checking their findings is interrupted, finish only those checks without rerunning the reviews:

```sh
npm run eval -- finish .eval-runs/RUN.json
```

This uses the local CLI login and does not use `AMP_EVAL_REVIEWER_API_KEY`. It writes a new result, keeps the original unchanged, and records the original file's hash so the two can be compared exactly.

## Reading the result

A normal report stays plain:

```text
Review evaluation: NEEDS WORK

2 pull-request seeds: 1 pass, 1 unstable, 0 fail.
1 version with no frozen issue, 1 version with an advisory label, and 1 version with a blocking label.
Each was reviewed 3 times. All 9 reviews completed.

Example 1 (pull request #1234): PASS (3/3 seed votes matched)
  Baseline, no frozen issues: 3 of 3 completed reviews raised no clean alert
  Introduced-issue version, blocking labels: found in 3 of 3; frozen-label response matched in 3 of 3
```

The saved file retains exact commits and context, every complete review and matching prompt, each matching response schema, the full SDK tool trace, model IDs, raw and filtered findings, conclusions, matching votes, separate review/matching timing, execution order, a trace-verified evidence-boundary audit, and errors. Treat it as private and potentially sensitive.

The primary unit is the pull-request seed, not an individual version or model call. A synthetic seed vote matches only when its baseline and introduced version both match in the same repeat. Three repeated votes are enough for an iteration check, not a broad accuracy claim: 3 of 3 is a provisional pass, 2 of 3 is unstable, and 0 or 1 needs work. With five predeclared runs, require at least 4 of 5. Never add only favorable reruns.

An alert on a version with no frozen issues is a **clean alert**, not automatically a false positive. Likewise, a finding that does not match a frozen card is an **unmatched finding**, not automatically an error. Check the source before classifying either. Report frozen-label agreement separately from any later source audit; do not call the matched-finding fraction precision.

An open example pack is a regression set. It is not a hidden benchmark, a population clean-alert rate, or proof of general review quality.
