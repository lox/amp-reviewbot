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

The pinned plugin prepares the source in the clean orb before the model starts. A failed or malformed setup cancels the turn. The reviewer's first tool call must then run a short exact Git check proving that the expected base and reviewed commits are present and that no remote remains. The saved trace also checks that the review used the chosen Amp mode and stayed in that workspace, research tools did not name the target pull request or repository, and the prepared repository did not run `git fetch` or `git pull`. A research request that explicitly tells a subagent not to inspect the target ("do not inspect example/repository or PR #42") counts as following the rule, and `git fetch` inside a quoted search pattern or in a throwaway repository (`git -C "$tmp/work" fetch`, or a `-C`, `--git-dir`, or `--work-tree` path that resolves outside the prepared workspace) does not count as updating the prepared source. Reading Git documentation (`git fetch -h`, `git help fetch`) and running non-Git experiments in another directory (a throwaway Go module under `/tmp`) are also allowed. A review that fails one of these checks is excluded from the counts like a review that never finished, the report says how many were excluded, and the result is marked incomplete; the other reviews in the run stay comparable. A review that Amp never started has no trace to check; it is reported as an unfinished review instead. The check uses the workspace named by the first shell command because Amp reports the trusted machine's path during startup and the mounted orb path in tool calls.

This is a rule plus a trace check, not a secure sandbox. A reviewer trying to cheat could hide a lookup in another process. Preventing all public access would make the test unlike a real review, so we accept that risk. The results measure a reviewer following the instructions in a realistic environment; they do not prove resistance to deliberate cheating.

The example data, recorded issues, focused tests, paired versions, and previous results remain private. Review calls require `AMP_EVAL_REVIEWER_API_KEY` from a separate identity that cannot access them. The review process receives only that key, an empty home directory, one prepared source copy, the pull-request context captured before the run, and the normal review instructions. A trusted local login is used later to compare findings with the recorded issues.

Older result files remain readable, but their reports clearly say that they are historical results and should not be compared with runs using the current rules.

## Amp mode and model

Production and evaluation reviews use the tracked `reviewbot-v1` Amp mode. It extends built-in `medium`, preserving that mode's prompt and tools, while pinning the main reviewer and Oracle to `openai/gpt-5.6-sol` at their existing reasoning levels. Finding comparisons similarly extend `high` through `reviewbot-judge-v1` and pin their main model and Oracle.

Every Amp account involved must install the exact [`pinned-models.js`](../plugins/pinned-models.js) file as a personal or workspace plugin: the production service account, the separate evaluation review account, and the local account used for finding comparisons. Besides pinning the agents, this plugin performs evaluation source setup before the model starts; ordinary production prompts do not activate that hook. An orb loads the plugin from the account running it, so keeping the file only in this repository is not enough. Do not also install it as a project plugin because duplicate mode keys are ambiguous. A missing or ambiguous mode stops the run instead of falling back to an unpinned model.

Amp still chooses models for specialist tools such as Search and Librarian. One plugin setting covers all specialists, so overriding it would replace their deliberately different routing and make the test less like production. The result therefore names the pinned main model without claiming that every supporting model is fixed.

Each result records the configured mode and model plus the exact Amp SDK and CLI versions. It also saves model IDs from the event stream when Amp reports them. Current Amp streams sometimes omit those IDs; an empty list means “not reported,” not “no model was used.”

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
Reviewer: Amp mode reviewbot-v1. Model: openai/gpt-5.6-sol. SDK: <exact SDK version>. CLI: <exact CLI version>.
Exact model IDs: not reported by Amp.

2 pull-request examples: 1 pass, 1 unstable, 0 fail.
1 version with no recorded issues, 1 version with recorded non-blocking issues, and 1 version with recorded blocking issues.
Each was reviewed 3 times. All 9 reviews completed.

Example 1 (pull request #1234): PASS (3/3 repeats passed)
  Baseline, no recorded issues: 3 of 3 completed reviews raised no alert
  Introduced-issue version, recorded blocking issues: found in 3 of 3; response matched the recorded issues in 3 of 3
```

The saved file keeps enough detail to reproduce and inspect the counts: exact commits and context, prompts, full tool traces, Amp mode, exact SDK and CLI versions, model IDs when Amp reports them, raw and filtered findings, matching decisions, timing, execution order, source checks, and errors. A report re-applies the latest trace checks to the stored traces without changing the original file, so a fixed check changes what an older report says. Treat the file as private and potentially sensitive.

Each source pull request is one example. For a synthetic before-and-after pair, one repeat passes only when the reviewer gets both versions right. Three repeats support a development check, not a broad accuracy claim: 3 of 3 is a provisional pass, 2 of 3 is unstable, and 0 or 1 needs work. If five repeats were chosen before the run, require at least 4 of 5. Never add only favorable reruns.

Production discards a finding whose `startLine` is not a line the pull request added, and the evaluation applies the same filter before checking findings against the recorded issues. A version line therefore also counts raw findings dropped for not pointing at a changed line. Those findings were never compared with the recorded issues, so read them in the saved file before calling a missed issue a reviewer miss.

An alert on a version with no recorded issues is not automatically a false positive: the recorded list may be incomplete. A finding that does not match a recorded issue is also not automatically wrong. Check the source before classifying either. Keep those later source checks separate from the original counts. Do not call the percentage of findings that matched recorded issues “precision,” because the remaining findings have not yet been proven wrong.

An open example pack helps catch the reviewer getting worse on known cases. It is not a hidden test, a representative estimate of all pull requests, or proof of general review quality.
