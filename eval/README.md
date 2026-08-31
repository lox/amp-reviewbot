# Review evaluation

This evaluation answers four questions:

1. Does the reviewer leave a version with no recorded issues alone?
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

[`example.json`](example.json) shows the format. It records the exact public pull-request context, whether the example comes from a human review or a deliberately broken change, and whether it is available during development or held back. Each version has a commit and a `knownIssues` list. That list is empty when no issue has been recorded. Each issue includes its cause, visible effect, severity, changed line, category, and verification evidence.

A human-review example has one exact version from before the fix. A synthetic example has a directly checked baseline and one child commit that adds exactly one issue. Any issue already present in the baseline is recorded for both versions; the child adds one more. The new issue must point to a line changed by the child commit. Behavioral bugs and maintainability advice stay separate: duplication and non-idiomatic Go are advice, not broken behavior.

The runner calculates changed lines from the exact Git diff. It does not store a second hand-written copy. It also calculates the expected `success`, `neutral`, or `failure` result from issue severity at `FAIL_ON=high`.

## What the reviewer can access

The reviewer gets the same public research tools as a real review. It may read public documentation, package registries, dependency source, and unrelated repositories.

There is one restriction: for the repository being reviewed, it must use only the copy we provide. It must not look up the target pull request through GitHub, nor clone, fetch, or inspect another copy of that repository. The supplied copy contains only the history needed for the exact base and reviewed commits. It has no remote, later commits, other branches, or evaluation labels.

The saved trace is checked for three things: the source setup ran first and completed in the original workspace; research tools did not name the target pull request or repository; and the prepared repository did not run `git fetch` or `git pull`. If one of these checks fails, the report says the run is invalid for comparison.

This is a rule plus a trace check, not a secure sandbox. A reviewer trying to cheat could hide a lookup in another process. Preventing all public access would make the test unlike a real review, so we accept that risk. The results measure a reviewer following the instructions in a realistic environment; they do not prove resistance to deliberate cheating.

The example data, recorded issues, focused tests, paired versions, and previous results remain private. Review calls require `AMP_EVAL_REVIEWER_API_KEY` from a separate identity that cannot access them. The review process receives only that key, an empty home directory, one prepared source copy, the pull-request context captured before the run, and the normal review instructions. A trusted local login is used later to compare findings with the recorded issues.

Older result files remain readable, but their reports clearly say that they are historical results and should not be compared with runs using the current rules.

## Commands

The `run` and `finish` commands start model calls. Get explicit confirmation before using either one.

Check the pack's files without starting reviews:

```sh
npm run eval -- check /path/to/review-eval-pack
```

Run development versions three times, with at most two reviews running at once. Held-back (`holdout`) examples are excluded by default:

```sh
export AMP_EVAL_REVIEWER_API_KEY="separate-review-account-key"
npm run eval -- run /path/to/review-eval-pack \
  --samples 3 \
  --concurrency 2
```

After choosing a candidate reviewer, run the held-back examples explicitly:

```sh
npm run eval -- run /path/to/review-eval-pack \
  --split holdout \
  --samples 3 \
  --concurrency 2
```

Do not set `AMP_API_KEY`; the evaluation uses the authenticated local CLI to compare findings with recorded issues and rejects an `AMP_API_KEY` inherited from the shell. Confirm that the separate review identity cannot access the example pack before running either group.

Read a saved result without making network or model calls:

```sh
npm run eval -- report .eval-runs/RUN.json
```

If reviews finish but checking their findings is interrupted, finish only those checks without rerunning the reviews:

```sh
npm run eval -- finish .eval-runs/RUN.json
```

This uses the local CLI login and does not use `AMP_EVAL_REVIEWER_API_KEY`. It writes a new result, keeps the original unchanged, and records the original file's hash so the two can be compared exactly.

## Reading a result

A report starts by saying what access was allowed and explains each repeat in plain terms:

```text
Review evaluation: PUBLIC RESEARCH ALLOWED
Recorded result: NEEDS WORK
The reviewer could research anything public except this pull request and another copy or later version of the target repository.

2 pull-request examples: 1 pass, 1 unstable, 0 fail.
1 version with no recorded issues, 1 version with recorded non-blocking issues, and 1 version with recorded blocking issues.
Each was reviewed 3 times. All 9 reviews completed.

Example 1 (pull request #1234): PASS (3/3 repeats passed)
  Baseline, no recorded issues: 3 of 3 completed reviews raised no alert
  Introduced-issue version, recorded blocking issues: found in 3 of 3; response matched the recorded issues in 3 of 3
```

The saved file keeps enough detail to reproduce and inspect the counts: exact commits and context, prompts, full tool traces, model IDs, raw and filtered findings, matching decisions, timing, execution order, source checks, and errors. A report also applies the latest trace checks without changing the original file. Treat the file as private and potentially sensitive.

Each source pull request is one example. For a synthetic before-and-after pair, one repeat passes only when the reviewer gets both versions right. Three repeats support a development check, not a broad accuracy claim: 3 of 3 is a provisional pass, 2 of 3 is unstable, and 0 or 1 needs work. If five repeats were chosen before the run, require at least 4 of 5. Never add only favorable reruns.

An alert on a version with no recorded issues is not automatically a false positive: the recorded list may be incomplete. A finding that does not match a recorded issue is also not automatically wrong. Check the source before classifying either. Keep those later source checks separate from the original counts. Do not call the percentage of findings that matched recorded issues “precision,” because the remaining findings have not yet been proven wrong.

An open example pack helps catch the reviewer getting worse on known cases. It is not a hidden test, a representative estimate of all pull requests, or proof of general review quality.
