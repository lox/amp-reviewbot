# Review evaluation

This evaluation answers four questions:

1. Does the reviewer leave a clean change alone?
2. Does it find each known bug?
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

[`example.json`](example.json) shows the format. It records the exact public pull-request context and one or more code versions. Each version has a commit and `knownIssues`. A clean version has an empty list. A bug records its cause, visible failure, severity, changed line, and how it was checked.

The runner calculates changed lines from the exact Git diff. It does not store a second hand-written copy. It also calculates the expected `success`, `neutral`, or `failure` result from issue severity at `FAIL_ON=high`.

## Keep reviews blind

Use two Amp accounts:

- The trusted account can read the private example pack and checks whether findings match known bugs.
- A separate review account can access the source project, but cannot access the example pack.

Supply the keys through the environment, never as command arguments:

```sh
export AMP_API_KEY="trusted-account-key"
export AMP_EVAL_REVIEWER_API_KEY="separate-review-account-key"
```

`AMP_API_KEY` is used by the main process. `AMP_EVAL_REVIEWER_API_KEY` is passed only to a child process with an empty home directory. The child starts fresh private review orbs in the project named by `--project`. The two keys must belong to different Amp accounts, not merely be two keys from one account.

The project is selected by `--project`; there is no need to log the Amp CLI in and out between reviews. Amp's SDK uses the standard `AMP_API_KEY` value in each process.

The reviewer receives only:

- the exact base and head commits;
- the public pull-request title, description, and branch names;
- the production review instructions; and
- source-only Git bytes for a deliberately changed commit when needed.

It never receives `knownIssues`, focused tests, or the path to the pack. The trusted process checks the bundle and commit IDs before any reviews start.

## Commands

Check the pack's files without starting reviews:

```sh
npm run eval -- check /path/to/review-eval-pack
```

Run every code version three times, with at most two reviews running at once:

```sh
npm run eval -- run /path/to/review-eval-pack \
  --project REVIEW_PROJECT \
  --samples 3 \
  --concurrency 2
```

Before the first review, this command fetches the public source, verifies any source bundle, checks every commit, calculates changed lines, and rejects a known bug that does not point to a changed line.

Every review then uses a fresh private Amp orb and the same prompt builder, two-pass review method, JSON parser, changed-line filter, and conclusion calculation as production. The trusted account uses two independent high-mode checks to decide whether a finding describes a known bug; it uses a third only when they disagree.

The command prints progress and saves complete results under `.eval-runs/`. Read a saved result without making network or model calls:

```sh
npm run eval -- report .eval-runs/RUN.json
```

## Reading the result

A normal report stays plain:

```text
Review evaluation: NEEDS WORK

1 clean change, 1 smaller bug, and 1 serious bug.
Each was reviewed 3 times. All 9 reviews completed.

Example 1 (pull request #1234)
  Clean change: 3 of 3 completed reviews had no false alarms
  Smaller bug: found in 3 of 3; right response in 2 of 3
  Serious bug: found in 3 of 3; right response in 0 of 3
```

The saved file retains exact commits and context, prompt and code hashes, model IDs when available, raw and filtered findings, conclusions, matching votes, timing, and errors.

Three repeated reviews are enough for an iteration check, not a broad accuracy claim. Decide the rule before running: 3 of 3 is a provisional pass; 2 of 3 means run both the old and new reviewer five times; 0 or 1 means the reviewer needs work on that example. With five runs, require at least 4 of 5. Never add only favorable reruns.

An open example pack is a regression set. It is not a hidden benchmark, a population false-alarm rate, or proof of general review quality.
