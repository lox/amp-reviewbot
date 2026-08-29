# Review evaluation

This evaluation answers four questions:

1. Does the reviewer leave a clean change alone?
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

[`example.json`](example.json) shows the format. It records the exact public pull-request context, whether the example is a pilot, human review, or synthetic change, and whether it is used during development or held back. Each version has a commit and `knownIssues`. A clean version has an empty list. An issue records its cause, visible effect, severity, changed line, category, and how it was checked.

A human-review example has one exact pre-fix version. A synthetic example has one clean version and one direct child commit with a single introduced issue. The labeled line must be changed by that child commit, not merely by the original pull request. Behavioral defects and maintainability advisories are recorded separately; duplication and non-idiomatic Go are advisories rather than behavioral bugs.

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
- source-only Git bytes for a deliberately changed commit when needed.

It never receives `knownIssues`, focused tests, or the path to the pack. The trusted process checks the bundle and commit IDs before any reviews start.

Source-only transfers over 64 KiB are rejected so one deliberately changed commit cannot make every repeated review unexpectedly large or expensive. Keep each synthetic change focused.

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

Before the first review, this command validates any review key, fetches the public source, verifies any source bundle, checks every commit, calculates changed lines, and rejects a known issue that does not point to a changed line. For a synthetic example, it also checks that the issue version is one commit on top of the clean version and that the labeled line changed in that commit.

Every review then uses a fresh private Amp orb and the same prompt builder, two-pass review method, JSON parser, changed-line filter, and conclusion calculation as production. The trusted account uses two independent high-mode checks to decide whether a finding describes a known issue; it uses a third only when they disagree.

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

1 clean change, 1 smaller issue, and 1 serious issue.
Each was reviewed 3 times. All 9 reviews completed.

Example 1 (pull request #1234)
  Clean change: 3 of 3 completed reviews had no false alarms
  Smaller issue: found in 3 of 3; right response in 2 of 3
  Serious issue: found in 3 of 3; right response in 0 of 3
```

The saved file retains exact commits and context, prompt and code hashes, model IDs when available, raw and filtered findings, conclusions, matching votes, timing, and errors.

Three repeated reviews are enough for an iteration check, not a broad accuracy claim. Decide the rule before running: 3 of 3 is a provisional pass; 2 of 3 means run both the old and new reviewer five times; 0 or 1 means the reviewer needs work on that example. With five runs, require at least 4 of 5. Never add only favorable reruns.

An open example pack is a regression set. It is not a hidden benchmark, a population false-alarm rate, or proof of general review quality.
