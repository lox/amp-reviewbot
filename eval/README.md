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

## Research-enabled execution

The evaluation deliberately gives the reviewer the same research-capable environment as a production review. It can consult public documentation, package registries, dependencies, and other repositories. This improves production parity but means the protocol is not adversarially blind.

The narrower rule is that the reviewer must use only the supplied snapshot for the target repository. It must not inspect the target pull request through GitHub pages or APIs, and must not clone, fetch, or inspect another copy of the target repository. The supplied Git repository contains only the exact base and reviewed commit histories, with no remote, later commits, other branches, or evaluation labels.

The full trace is audited for observable violations of that rule. A violation marks the run contaminated. The instruction and audit are not a security boundary: a sufficiently determined reviewer could conceal a lookup through an arbitrary child process. We accept that risk as a trade-off for evaluating the reviewer in an environment that matches real reviews. Results therefore measure a cooperative, research-enabled reviewer, not resistance to deliberate benchmark cheating.

The example pack, issue cards, witnesses, paired version, and previous results remain private. Review calls require `AMP_EVAL_REVIEWER_API_KEY` from a separate identity that cannot access the pack. The review child receives only that key, an empty home directory, one prepared source snapshot, frozen pull-request context, and the production review instructions. Trusted matching continues through the local CLI login.

Historical artifacts created under the earlier unrestricted diagnostic protocol remain readable and continue to report `DIAGNOSTIC ONLY`.

## Commands

Check the pack's files without starting reviews:

```sh
npm run eval -- check /path/to/review-eval-pack
```

Run development versions three times, with at most two reviews running at once. Holdout examples are excluded by default:

```sh
export AMP_EVAL_REVIEWER_API_KEY="separate-review-account-key"
npm run eval -- run /path/to/review-eval-pack \
  --samples 3 \
  --concurrency 2
```

After choosing a candidate reviewer, run only the frozen holdout explicitly:

```sh
npm run eval -- run /path/to/review-eval-pack \
  --split holdout \
  --samples 3 \
  --concurrency 2
```

Do not set `AMP_API_KEY`; evaluation uses the authenticated local CLI for trusted matching and rejects an ambient API key. Confirm that the separate review identity cannot access the example pack before running either split.

Read a saved result without making network or model calls:

```sh
npm run eval -- report .eval-runs/RUN.json
```

If reviews finish but checking their findings is interrupted, finish only those checks without rerunning the reviews:

```sh
npm run eval -- finish .eval-runs/RUN.json
```

This uses the local CLI login and does not use `AMP_EVAL_REVIEWER_API_KEY`. It writes a new result, keeps the original unchanged, and records the original file's hash so the two can be compared exactly.

## Reading the result

A new report makes the protocol explicit:

```text
Review evaluation: RESEARCH-ENABLED
Recorded result: NEEDS WORK
Public research was allowed, but the reviewer was required to use only the supplied snapshot for the target repository and not inspect the target pull request.

2 pull-request seeds: 1 pass, 1 unstable, 0 fail.
1 version with no frozen issue, 1 version with an advisory label, and 1 version with a blocking label.
Each was reviewed 3 times. All 9 reviews completed.

Example 1 (pull request #1234): PASS (3/3 seed votes matched)
  Baseline, no frozen issues: 3 of 3 completed reviews raised no clean alert
  Introduced-issue version, blocking labels: found in 3 of 3; frozen-label response matched in 3 of 3
```

The saved file retains exact commits and context, every complete review and matching prompt, each matching response schema, the full SDK tool trace, model IDs, raw and filtered findings, conclusions, matching votes, separate review/matching timing, execution order, its original trace audit, and errors. Reports apply the current audit separately without rejecting an unchanged artifact when detection rules evolve. Treat the file as private and potentially sensitive.

The primary unit is the pull-request seed, not an individual version or model call. A synthetic seed vote matches only when its baseline and introduced version both match in the same repeat. Three repeated votes are enough for an iteration check, not a broad accuracy claim: 3 of 3 is a provisional pass, 2 of 3 is unstable, and 0 or 1 needs work. With five predeclared runs, require at least 4 of 5. Never add only favorable reruns.

An alert on a version with no frozen issues is a **clean alert**, not automatically a false positive. Likewise, a finding that does not match a frozen card is an **unmatched finding**, not automatically an error. Check the source before classifying either. Report frozen-label agreement separately from any later source audit; do not call the matched-finding fraction precision.

An open example pack is a regression set. It is not a hidden benchmark, a population clean-alert rate, or proof of general review quality.
