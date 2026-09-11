# Review-quality evaluation

## Goal

Give us a fast, credible way to improve amp-reviewbot without pretending an LLM is deterministic or comparing review prose.

**Status:** example validation, realistic review runs, complete evidence saving, scoring, and offline reports are implemented. The reviewer can use public research, as it can in production, but must use only our supplied copy of the target repository and must not inspect the target pull request. We check the saved trace for obvious breaches, but this is not a secure sandbox.

For each exact code version in the full outer loop, measure:

- whether the final result is `success`, `neutral`, or `failure` at `FAIL_ON=high`;
- whether each known material issue was found;
- how many findings did not match a recorded issue and therefore need source checking;
- whether the issue had the right urgency—high findings block, lower severities do not; and
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

`example.json` contains public pull-request context once, followed by one or more exact code versions. It records whether the example is a pilot, human review, or deliberately broken change, and whether it is used during development or held back. Each version has a `knownIssues` list. An issue records its cause, visible failure, severity, category, changed location, and verification evidence.

This handles both example groups:

- a historical pre-fix revision where a non-author human review requested a concrete change and independent evidence confirms the issue; and
- a directly checked baseline plus one child commit containing exactly one deliberately introduced issue, normally paired with focused evidence. Any issue already present in the baseline is recorded in both versions, although its source line may move; the child adds exactly one issue.

Behavioral defects and maintainability advisories are distinct. Substantial duplicated logic can be a medium advisory when it has a concrete divergence cost. Non-idiomatic Go is low and requires official guidance or a dominant repository convention. Neither is described as a behavioral bug.

Approval, merge, draft status, and silence do not prove that a version is correct. A baseline must be checked directly. When an LLM checked an issue, say so rather than presenting it as certain human judgment.

## Run path

There are two loops. The inner loop is deliberately small: `npm run eval -- ab PACK fast-v1 A_VARIANT B_VARIANT` runs one review from each prompt variant over a frozen 16-version set, interleaved under one concurrency limit. Variants are the current prompt, the built-in pre-severity-guide prompt, or plain-text files of additional trusted instructions; candidate code is never loaded on the corpus machine. The set was selected with 10 settled blocking versions from varied bug mechanisms and source pull requests, 3 clean versions, and 3 undisputed advisory-only versions. One adjudicated label correction now makes that 11 blocking, 3 clean, and 2 advisory-only without changing membership. It lives in the private pack. Membership, blocking policy, runner, mode, and model stay fixed; labels change only after explicit adjudication and offline re-scoring. Only the prompt changes during an experiment.

The inner loop reads the binary production decision directly from each saved `conclusion`. It does not run issue-matching judges, usage lookups, advisory scoring, repeat classification, trace gating, or sign tests. It still saves raw output and traces, uses the separate reviewer identity, prepares the exact isolated source, and applies production parsing and changed-line filtering. The rule is applied to paired calls and works in both directions. A candidate is **PROMISING** when it nets at least 3 more blocking versions with no net new wrong blocks, or removes at least 2 net wrong blocks with no net blocking loss, and no missing review could change that result. A net loss of at least 2 blocking detections, or at least 1 net new wrong block, is a **REGRESSION**. Every other outcome is **KEEP A** and ends the experiment. These thresholds are product choices, not statistical claims. People must read the high findings behind gains before promoting a candidate.

The outer loop runs about weekly: incumbent versus one selected candidate on the larger development set. It audits the validity of blocking findings and suspicious traces, batches label corrections, runs `npm run eval -- rescore PACK RUN.json [...]` to re-score saved reviewer outputs after those corrections, and adds varied blocking mutants and hard non-blocking examples. Re-scoring is offline: it preserves the source artifact, writes a derived artifact beside it, and excludes versions whose commit, PR context, prepared source, or non-label issue meaning changed. Finding-match judges, advisory and silence scoring, repeat stability, and sign tests belong here. The holdout is used only after candidate selection. A label edit is not a reason to buy the same reviews again.

Holdout results are final. The first candidate to reach the holdout, a four-check scope gate in the Finding Bar, was PROMISING on the 60-version development set (blocking 19/21 versus 18/21, wrong blocks 12/39 versus 18/39) and a REGRESSION on the 30-version holdout (blocking 5/5 on both sides, wrong blocks 17/25 versus 16/25, three added). It shipped before the holdout run and was reverted afterwards. Both prompts wrongly blocked a large share of the non-blocking versions (31–46% on the development set, 64–68% on the holdout), and offline adjudication of the development-set flips found that most of those "wrong" blocks were real high-severity bugs with stale medium labels. That audit then covered every version the pre-gate prompt wrongly blocked: 26 of 34 were real high-severity bugs, 7 were false positives, and 1 stayed uncertain. After the corrections the development split is 35 blocking, 6 clean, and 19 advisory-only, the holdout was 19, 7, and 4 at the rescore, and re-scoring the saved reviews gave the pre-gate prompt 25/29 blocking and 5/22 wrong blocks on the development set and 17/18 and 3/10 on the holdout. A later adjudication added a high to one holdout clean version (#4110), so the final holdout is 20, 6, and 4 and the same saved reviews score 17/19 and 3/9. The remaining wrong blocks share one pattern: recoverable, unreachable-in-practice, or development-only problems rated high. A severity-calibration gate written against that pattern was then a REGRESSION on the corrected `fast-v2` set, losing three blocking calls to remove one wrong block, and an eval-only severity re-pass over the blocking findings was KEEP A: it kept every wrong block and lowered one real one. Severity-suppression experiments are closed; a read-only audit of the six misses found four detection misses and two calibration misses, with only one unstable between runs, so a multi-sample majority trial is not justified either. Every experiment and its verdict is recorded in [eval-experiments.md](../eval-experiments.md); read it before proposing a prompt change.

The enabled run path is:

```text
private example pack on the trusted machine
  -> verify exact source and calculate changed lines
  -> send every version through the same prepared-source path with public PR context
  -> parse and filter with production code
  -> compare findings with recorded issues using the trusted account
  -> calculate and save counts
```

Production and evaluation use the same:

- the exact `base...head` target;
- title, description, and branch names captured before the run;
- a fresh Amp orb using the production `reviewbot-v1` mode, which retains `medium` behavior while fixing its main model;
- the production review instructions and embedded two-pass review method;
- retry and JSON parsing behavior; and
- changed-line filtering and conclusion calculation.

The runner does not publish GitHub Checks, use the production queue, or give private example credentials to a review orb.

The trusted runner verifies the input commits and creates a fresh source-only Git bundle for every review. Each review starts in a clean orb with no Amp project and an empty workspace. Before the model starts, the pinned plugin creates a repository containing only the history needed for the exact base and reviewed commits, checks out the reviewed commit, and removes the remote. Project setup, repository instructions, other refs, reflogs, later objects, recorded issues, and focused tests are not transferred.

The setup block and review request are submitted together. Amp waits for plugins to load, then the plugin runs that exact block before the model starts. A missing workspace, malformed setup, or failed command cancels the turn. The model receives a short success message and must run an exact Git verification as its first tool call before inspecting the source. A successful review then uses only that prepared copy of the target repository. It must not inspect the target pull request through GitHub pages or APIs, nor clone, fetch, or inspect another copy of the target repository. Public documentation, package registries, dependencies, other repositories, and delegated research that follows the same rule are allowed.

The saved trace is checked for four things: the first tool call verified the exact prepared source and completed successfully; the review used the chosen Amp mode and did not explicitly move shell commands outside its prepared workspace; research tools did not name the target pull request or repository; and the prepared repository did not run `git fetch` or `git pull`. Amp reports the trusted machine's path during startup and the mounted orb path in tool calls, so the verification command establishes the workspace used by later checks. A breach makes the run invalid for comparison.

These checks are deliberately simple. A reviewer trying to cheat could hide a lookup in another process. Blocking all public access would make the test unlike a real review, so we accept that risk. The results measure a reviewer following the instructions in a realistic environment; they do not prove resistance to deliberate cheating.

The runner rejects a generated source-only transfer over 64 KiB. This keeps repeated reviews bounded and makes an oversized synthetic example a clear pack error instead of an unexpectedly slow or expensive run.

## Separate reviewer account

The example pack stays with the trusted account. The trusted process and matching orbs use the authenticated local Amp CLI. Reviews require a separate identity:

- `AMP_EVAL_REVIEWER_API_KEY`: separate review account, used only by the review child process.

The runner validates that key and stores only a hash of its Amp user ID. The review process gets a new empty home directory and only a small fixed list of environment variables. Comparing findings with recorded issues continues through the trusted local login. Before a run, the operator must confirm that the review identity cannot access the private example pack.

`AMP_API_KEY` is rejected so it cannot silently replace the local CLI login. Putting the examples and reviewer in two projects owned by the same account does not separate their access.

## Repeated runs

Run each version independently three times in reproducibly shuffled groups. Each group contains every selected version once, and the result file records the random ordering value and exact start order. Do not compare or average prose. Reduce each review to facts such as “issue found” and “right final result,” then combine versions belonging to the same source pull request.

Use a rule chosen before seeing results:

- 3 of 3 repeats: provisional pass for this small set;
- 2 of 3 repeats: unstable;
- 0 or 1 of 3: needs work on that example;
- at five runs, require at least 4 of 5.

Never replace a failed run or add runs only where the preferred version is behind. When comparing two reviewer versions, run both over the same examples and repeat count close together in time.

For a synthetic before-and-after pair, one repeat passes only when the reviewer gets both versions right. A baseline with a source-confirmed existing issue is checked against that issue rather than being called clean.

Deciding whether a finding describes a recorded issue also uses a model and can vary. These checks start only after every review has finished and the completed reviews have been saved privately. They have a separate timeout, so a slow or interrupted check cannot erase review results. Two independent calls in the `reviewbot-judge-v1` mode, which retains built-in `high` behavior, compare each recorded issue with the review findings. A third call breaks a disagreement. Identical checks are reused. The saved result includes every decision and the prompt, response format, SDK, CLI, configured mode and model, any model ID Amp reports, and timing behind it.

The tracked plugin modes extend Amp's built-in modes, preserving their prompts and tools while pinning each main agent and Oracle to `openai/gpt-5.6-sol` at the existing reasoning level. The same plugin prepares evaluation source before the model starts; production prompts do not activate it. The exact plugin file must be installed as a personal or workspace plugin for the production account, the separate review account, and the trusted account that compares findings. It must not also be installed as a project plugin because duplicate mode keys are ambiguous. Orbs load plugins from the account running them, not from this runner's filesystem. A missing or ambiguous mode stops the run instead of silently selecting another model.

Production and evaluation therefore use the same fixed reviewer. Amp still routes specialist tools such as Search and Librarian: its plugin API offers one override for all specialists, and replacing their different models with one would change production behavior. Results identify this remaining source of variation rather than claiming that every supporting model is fixed.

## What the report means

The main report scores the call production makes on each pull request: block it or let it through. It leads with three numbers:

- bad PRs blocked: versions with a recorded blocking bug where the reviewer reported that bug at blocking urgency, with the misses split into found-at-lower-urgency, missed, and blocked-for-something-else;
- OK PRs wrongly blocked: versions with no recorded blocking bug where the check would have failed, listed by version as the curation queue; and
- clean PRs left alone: versions with no recorded issues where the reviewer reported nothing.

Recorded advisory issues found is reported as an informational line. That list can never be complete, so the number is only meaningful relative to another run on the same examples. A pull-request example passes a repeat when every one of its versions gets the right call. `npm run eval -- compare A.json B.json` matches two saved runs version by version and says, for each number, how many versions each side won and whether that split could be chance. `--versions blocking,control` runs only the versions behind the blocking numbers for a fast screening pass.

Saved JSON keeps the exact commits, context, changed lines, prompts, full tool traces, configured Amp mode and main model, exact SDK and CLI versions, any model IDs Amp reports, raw output, filtered findings, conclusions, matching decisions, code hashes, separate timing, execution order, review-rule identifier, trace checks, and errors. Re-reading it makes no model or network calls. A review that breaks a rule is excluded from the counts and the result is marked `INCOMPLETE`. The file is private and potentially sensitive.

If matching fails after reviews finish, `npm run eval -- finish RUN.json` retries only the missing matches through the local CLI login. It writes a new file, preserves the original review evidence and timing, and records the exact hash of the source file. It does not rerun reviews or use the separate review-account key.

One finding can match at most one recorded issue, and one issue can be counted at most once per review. Extra findings stay visible until the source is checked. Do not call the percentage that matched recorded issues “precision,” because extra findings have not yet been proven wrong. A review of a version with a recorded blocking bug counts as the right call only when that bug is reported at blocking urgency; a review of any other version counts as the right call when it does not block.

## Scientific limits

The first open pack is for catching quality regressions during development. It is not a representative sample of all pull requests.

The pilot remains separate because its outcomes have already been seen. The main set has 60 different source pull requests: 30 exact human-reviewed versions and 30 baseline/synthetic pairs. Ten from each group are held back before any review run. Example membership, recorded issues, and rejection reasons are fixed before tuning starts.

Because LLMs create and check most recorded issues, report agreement with the examples, not “true accuracy.” Check every unmatched finding against the source before classifying it. If the reviewer finds a real issue missing from an example, fix the example (and record the issue in both versions of a synthetic pair) rather than call the finding a false alarm. Keep this later source check separate from the original counts.

## Before a run

1. Keep the example pack private and confirm the separate reviewer identity cannot access it.
2. Validate that each supplied repository has only the history needed for its base and reviewed commits, and no remote.
3. Fix the example set, development/held-back split, prompts, mode, repeat count, and matching rules before running a development sample.
4. Ask for explicit confirmation before starting any reviewer or matching model calls, including smoke, development, holdout, or `finish`.

## Verification

- Normal typecheck, tests, and build pass without live Amp calls.
- A local Git fixture proves source commits, bundles, changed lines, and issue anchors are checked. Synthetic issues must be introduced by one direct child commit and point to a line changed by that commit; inherited baseline semantics must be identical while source lines may move.
- Every generated review source bundle contains one target ref and no known-bug or witness data; every version receives the same neutral preparation shape.
- The runner uses local CLI authentication by default; when a review key is supplied, the review child receives only that key and basic connection settings.
- Production prompts are unchanged when no prepared-source boundary is requested.
- Saved runs reject altered example evidence, invalid finding indexes, conclusions that do not follow from raw production output, changed setup, review, or matching prompts and schemas, missing full prompts or traces, inconsistent timing, and changed execution order. They preserve the original trace check while reports also apply the current check, so improved detection does not make an unchanged file unreadable.
- Interrupted matching can finish into a new traceable result without changing or rerunning saved reviews.
- One finding cannot earn recall for two known issues.
- A run requires a separate review-account key and records the exact review rules, configured main model, Amp mode, SDK version, and CLI version it used.
- Public dependency and documentation research is allowed. If the trace shows access to the target pull request or another copy of the target repository, the run is invalid for comparison.
