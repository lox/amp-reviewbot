# Review evaluation

Production makes one call per pull request: block it or let it through. With `FAIL_ON=high`, any high or critical finding fails the check; anything less leaves it neutral. This evaluation scores that call. Each saved run leads with a scorecard of three numbers:

1. **Bad PRs blocked** — versions with a recorded blocking bug where the reviewer reported that bug at blocking urgency. Finding the bug but calling it medium does not count; production would have let the PR through.
2. **OK PRs wrongly blocked** — versions with no recorded blocking bug where the check would have failed.
3. **Clean PRs left alone** — versions with no recorded issues where the reviewer reported nothing.

A fourth line, recorded advisory issues found, is informational. Nobody can enumerate every real nit in a pull request, so the list of non-blocking issues is always incomplete and that number only means something relative to another run on the same examples.

A pull-request example passes a repeat when every one of its versions gets the right call: blocked for the recorded bug, or not blocked. The answers are counts, not prose comparisons. A saved run keeps the exact evidence behind those counts.

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

Result files from before the current access rules are labelled `OLDER RULES` in the report and flagged by `compare`; do not compare them with current runs.

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

Compare two saved results, version by version, without network or model calls:

```sh
npm run eval -- compare .eval-runs/BASELINE.json .eval-runs/CANDIDATE.json
```

To try a prompt idea quickly, review only the versions that drive the blocking numbers (about a quarter of the reviews of a full development run):

```sh
npm run eval -- run /path/to/review-eval-pack --versions blocking,control --samples 1
```

Use that to discard ideas that clearly do not help. Confirm a promising one with the full three-repeat development run, then compare the two saved results. Run the held-back examples only when you have stopped iterating.

If reviews finish but checking their findings is interrupted, finish only those checks without rerunning the reviews:

```sh
npm run eval -- finish .eval-runs/RUN.json
```

This uses the local CLI login and does not use `AMP_EVAL_REVIEWER_API_KEY`. It writes a new result, keeps the original unchanged, and records the original file's hash so the two can be compared exactly.

## Reading a result

A report starts by saying what access was allowed, then gives the scorecard:

```text
Review evaluation: PUBLIC RESEARCH ALLOWED
Recorded result: NEEDS WORK
The reviewer could research anything public except this pull request and another copy or later version of the target repository.
Reviewer: Amp mode reviewbot-v1. Model: openai/gpt-5.6-sol. SDK: <exact SDK version>. CLI: <exact CLI version>.
Exact model IDs: not reported by Amp.

Scorecard: 3 code versions from 2 pull requests, each reviewed 3 times; all 9 reviews completed.
  Bad PRs blocked:        2 of 3 (67%) across 1 version with a recorded blocking bug; 0 blocked every time. Of the rest: 0 blocked for something else, 1 found the bug at lower urgency, 0 missed it.
  OK PRs wrongly blocked: 2 of 6 (33%) across 2 versions without one; 1 never blocked.
  Clean PRs left alone:   3 of 3 (100%) across 1 version with no recorded issues.
  Recorded advisory issues found: 5 of 6 (83%).
Right call: a version with a recorded blocking bug is blocked for that bug at blocking urgency; every other version is not blocked.
2 pull-request examples: 0 pass, 1 unstable, 1 fail.
Review time: 9 reviews took 24.3 min in total; median 2.5 min, longest 6.1 min.
Amp usage: $7.20 in credits, 4.4M input tokens, 31k output tokens, 63 model requests; median $0.80 per review. Subagent threads are included.

Wrongly blocked (check the source; a justified block means the recorded issues are incomplete):
  #1300 version: blocked in 2 of 3

Example 1 (pull request #1234): UNSTABLE (right call in 2/3 repeats)
  Baseline, no recorded issues: left alone in 3 of 3
  Introduced-issue version, recorded blocking bug: blocked for it in 2 of 3; found it at lower urgency in 1
Example 2 (pull request #1300): FAIL (right call in 1/3 repeats)
  Version, recorded non-blocking issues: not blocked in 1 of 3; wrongly blocked in 2; 5 of 6 recorded advisory issues found; 2 unmatched findings need source checking
```

The "Of the rest" split on the first line says where blocked-PR misses come from. "Found the bug at lower urgency" means the reviewer described the recorded bug but rated it medium or low, so the fix is urgency calibration; "missed it" means the bug was never described, so the fix is detection. "Blocked for something else" means the check failed on a finding that matched no recorded blocking bug; that block may be right, but it gets no credit until the source is checked and the issue recorded.

The "Wrongly blocked" list is the curation queue. Each entry is a version the reviewer would have blocked although no recorded issue justifies it. Read the finding and the source. If the block was right, record the issue in the example pack so the next run credits it; if it was wrong, the count stands.

Three repeats support a development check, not a broad accuracy claim: 3 of 3 is a provisional pass, 2 of 3 is unstable, and 0 or 1 needs work. If five repeats were chosen before the run, require at least 4 of 5. Never add only favorable reruns.

## Comparing two runs

`compare` puts a baseline and a candidate side by side. It matches each version with itself, so a hard version cannot tilt the result. A version counts as shared only when both runs reviewed the same commits against the same recorded issues (same IDs, severities, and lines); versions present in only one run, or changed between packs, are left out of every number shown, including the two scorecards. If either run has reviews that did not finish, broke the rules, or left recorded issues unchecked, an `Incomplete` line says how many and warns that the difference is tentative. For each of the three scorecard numbers it lists the versions where the candidate did better and where the baseline did better:

```text
Bad PRs blocked:
  A 25 of 60 (42%), B 26 of 58 (45%).
  B better on 3 versions, A better on 2, same on 15. Only 5 versions differ: too few to tell from chance.
```

The last sentence is a plain-language sign test: if the two reviewers were really the same, each version that differs would be equally likely to favour either side, and the sentence says how often chance alone gives a split at least this lopsided. Under 5% is reported as a real difference. Fewer than six differing versions can never clear that bar, so with the current pack a change has to be large to show up in the blocking numbers; the pack needs more versions with blocking bugs before small improvements are measurable. Synthetic before-and-after pairs are the cheapest way to add them.

The advisory line compares recorded non-blocking issues found. Because that list is incomplete, treat it as a relative signal, and remember that a candidate which finds different real issues than the recorded ones gets no credit for them.

The saved file keeps enough detail to reproduce and inspect the counts: exact commits and context, prompts, full tool traces, Amp mode, exact SDK and CLI versions, model IDs when Amp reports them, raw and filtered findings, matching decisions, timing, what Amp billed for the review thread (`amp threads usage`, read after the review returns; subagent threads are included, a thread abandoned by a restart is not), execution order, source checks, and errors. Usage totals cover every review including excluded ones, since they still cost money. Credits are $0 when a subscription covered the inference; the report says so. When Amp reports no usage for a thread (it currently answers "Usage information is currently unavailable for this thread" for threads run under some accounts) or the lookup fails, the file records the reason, and the report quotes it. A run without usage falls back to tokens summed from the traces, which omit subagent turns and cost. A report re-applies the latest trace checks to the stored traces without changing the original file, so a fixed check changes what an older report says. Treat the file as private and potentially sensitive.

Each source pull request is one example. For a synthetic before-and-after pair, one repeat passes only when the reviewer gets both versions right.

Production discards a finding whose `startLine` is not a line the pull request added, and the evaluation applies the same filter before checking findings against the recorded issues. A version line therefore also counts raw findings dropped for not pointing at a changed line. Those findings were never compared with the recorded issues, so read them in the saved file before calling a missed issue a reviewer miss.

A wrongly blocked version or an alert on a version with no recorded issues is not automatically a false positive: the recorded list may be incomplete. A finding that does not match a recorded issue is also not automatically wrong. Check the source before classifying either. Keep those later source checks separate from the original counts, and do not call the share of findings that matched recorded issues “precision,” because the remaining findings have not yet been proven wrong.

An open example pack helps catch the reviewer getting worse on known cases. It is not a hidden test, a representative estimate of all pull requests, or proof of general review quality.
