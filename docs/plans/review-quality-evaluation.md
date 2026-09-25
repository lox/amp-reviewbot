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

### Fast prompt checks

`npm run eval -- ab PACK fast-v1 A_VARIANT B_VARIANT` runs one review per prompt over a frozen 16-version set, interleaved under one concurrency limit.

- Variants are `current`, `pre-severity-guide`, or plain-text files of additional trusted instructions. Candidate code never runs on the corpus machine.
- The private set started with 10 blocking, 3 clean, and 3 advisory-only versions. One adjudicated label correction makes that 11/3/2 without changing membership.
- Membership, blocking policy, runner, mode, and model stay fixed. Labels change only after explicit adjudication and offline re-scoring.

The fast loop scores each saved `conclusion`. It skips issue matching, usage lookups, advisory scoring, repeat classification, trace gating, and sign tests. It still saves raw output and traces, uses the separate reviewer identity, prepares isolated source, and applies production parsing and changed-line filtering.

Apply the rule to paired calls:

- **PROMISING:** at least 3 net additional blocking versions caught with no net new wrong blocks, or at least 2 net wrong blocks removed with no net blocking loss. No missing review may change that result.
- **REGRESSION:** at least 2 net blocking detections lost, or at least 1 net new wrong block.
- **KEEP A:** everything else. End the experiment.

These are product thresholds, not statistical claims. Read the high findings behind gains before promoting a candidate. If that audit corrects a label, keep the verdict under the original labels and report the corrected interpretation separately. A correction must not advance a candidate retroactively.

### Full evaluation

About weekly, compare the incumbent with one selected candidate on the larger development set:

- Audit blocking findings and suspicious traces.
- Batch label corrections, then run `npm run eval -- rescore PACK RUN.json [...]` on saved reviews.
- Add varied blocking mutants and hard non-blocking examples.
- Check issue matches, advisory findings, silence on clean versions, repeat stability, and sign tests.

Re-scoring is offline. It preserves the source artifact and writes a derived copy beside it. Versions are excluded if their commit, PR context, prepared source, or issue meaning beyond labels changed. A label edit is not a reason to buy the same reviews again.

Use the holdout only after selecting a candidate. Its result is final.

### What has held up so far

`current` stays. The scope gate shipped before its holdout run, failed there, and was reverted. Later source checks corrected many supposed wrong blocks: the labels, rather than the reviews, were wrong.

With corrected labels, the saved reviews block 25/30 evaluable development bugs with 5/21 wrong blocks, and 17/19 holdout bugs with 3/9 wrong blocks. Severity-suppression experiments are closed: wording changes and a second severity pass did not improve the result.

The effective-default experiment also finished KEEP A after source adjudication. Only one development miss varied across saved runs, so a multi-sample majority trial is not justified. Read the [experiment record](../eval-experiments.md) for the full results and label history before proposing another prompt change.

### Source preparation

The full run follows this path:

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

## Post-v4 tranche (planned)

Every example is a buildkite-agent pull request from the v3 line. buildkite-agent v4 has shipped, so the code the reviewer sees in production has moved on: new packages, removed compatibility paths, and different release scripts. The corpus should follow, without disturbing what the existing sets measure.

Author both tranches before scoring either:

- Development: 10–12 human-reviewed pull requests plus 4 synthetic pairs.
- Holdout: 6–8 human-reviewed pull requests plus 2 synthetic pairs.

Human-reviewed examples follow the existing protocol: a non-author reviewer requested a concrete change, independent evidence confirms the issue, and the baseline is checked directly. Aim for roughly half blocking and half advisory-only, meaning a confirmed issue below `high`.

The mix matters. Every persistent wrong block so far is on an advisory-only or clean version, usually for a recoverable or development-only problem rated high. Synthetic pairs provide the `clean-control` baselines: the strict pack schema requires human-review examples to carry a known issue, so clean versions only exist as pair baselines. A drift result needs blocking, advisory-only, and clean versions from the start.

### Corpus decisions

- Existing examples are not relabelled or retired because v4 shipped. Their labels describe the code at their commit, and a v3 behaviour that v4 later removed or changed was still correct or incorrect at that commit. A v3 label proven wrong at its own commit is still corrected through the existing adjudication-and-`rescore` process (see the label audit in [eval-experiments.md](../eval-experiments.md)); that process re-derives the affected numbers rather than invalidating them.
- Score the development tranche under `current`. Once its outcomes inform a prompt change, it is development evidence regardless of how it was originally filed.
- Freeze the holdout at the same time, before any post-v4 scoring. Do not run even a `current`-vs-`current` screen until a candidate is selected.
- If no candidate emerges, never run the holdout.
- No new pack field. The example schema is strict, so an `era` field would be a framework change. The tranche is identifiable by its example IDs and by pull numbers above the v4 release, but `report` formats a whole saved run and `rescore` processes every case in one, and neither filters by example or set, so the reporting boundary is the saved run itself: the tranche is only ever run on its own (through `--set`, below), so every artifact that contains it contains nothing else. Add a field, and set-based filtering to `report` and `rescore`, only if mixed runs and per-era reporting are actually wanted.
- `fast-v3`, if one is ever needed, is built from the post-v4 development tranche, never from the holdout tranche: selecting a tuning set from held-back examples would leak them into the inner loop. As with `fast-v2`, it is selected from settled calls after the development tranche has been scored once under `current`; adding unscored versions to a fast set would make an A/B result depend on which prompt happened to see them first.

### Holdout protocol and verdict

Run the single final A/B through full scoring, not `ab`:

1. Run `run --set` once per prompt with three repeats and finding-match judging.
2. Use each version's majority call.
3. Run `compare` on the two saved runs.

`ab` is only a screen. It takes one sample per prompt and scores the binary call, so an unrelated block can count as catching the recorded bug and one stochastic flip can decide the result.

Both full runs must be complete: no `INCOMPLETE` marker and every version scored under both prompts. Otherwise there is no verdict. Repair with `finish` or rerun; never read a partial holdout.

The candidate ships only if it does one of these against `current` on the same versions:

- catches at least 2 net additional blocking versions with no net new wrong block; or
- removes at least 2 net wrong blocks on advisory-only or clean versions with no net blocking loss.

Any net blocking loss or net new wrong block is a REGRESSION. Everything else is KEEP A.

These thresholds assume 5–6 blocking versions (3–4 human-reviewed plus 2 mutants), 2 clean baselines, and 3–4 advisory-only versions. Do not revise them after authoring. If the tranche misses that composition, fill it before freezing.

### Required runner work

Score only the new versions. `run --split development` would buy all 60 existing development versions again, with three samples each, including cases earlier artifacts dropped or excluded.

The required framework change is still planned:

- add `--set NAME` to `run`, restricting a split to a frozen set's members;
- add `--prompt VARIANT`, using the same variant reference as `ab` and defaulting to `current`.

This gives the tranche the normal three repeats, finding-match judging, and `finish` path. Record its score beside the v3 numbers in [eval-experiments.md](../eval-experiments.md), not merged into them.

Until that work ships, `ab PACK SET current current` is only a preliminary screen, as `gap-v1` was. It uses one sample per version and binary calls only; an unrelated block counts the same as finding the recorded bug. Label it as a screen. Either command still needs explicit confirmation before paid model calls.

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
