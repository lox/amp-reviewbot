# Review-quality evaluation plan

## Problem

amp-reviewbot needs a fast way to compare prompt, methodology, and model changes on realistic pull requests. The evaluation must exercise the real review path, measure material issue detection without comparing prose, expose false positives and severity mistakes, and show run-to-run instability.

Manually producing and maintaining human-labeled historical reviews is not practical. Inferring labels from review comments, approvals, merge status, or draft status is also not credible. The first evaluation will therefore use controlled fault injection and explicitly LLM-adjudicated labels rather than claim human ground truth.

## Decision

Build a paired mutation corpus from historical snapshots of `buildkite/buildkite` and `buildkite/agent`.

Each seed snapshot produces three exact review targets:

1. An unchanged control that stronger-model reviewers certify has no material introduced issue.
2. A variant with one subtle advisory defect, expected to produce `neutral` at `FAIL_ON=high`.
3. A variant with one subtle blocking defect, expected to produce `failure` at `FAIL_ON=high`.

Every injected defect has a frozen failure card and, where technically possible, a hidden executable witness that passes on the control and fails on the mutated revision. The production reviewer never sees the failure card or witness.

Prove the loop with three seeds and nine cases, including both repositories and at least two non-concurrency failure classes. Expand to eight seeds, four from each repository, before treating it as the initial regression corpus. Neither size is a statistically representative benchmark.

Neither the production reviewer nor its LLM judges are expected to be deterministic. Determinism applies only to the exact replay inputs, frozen references, cached judge resolutions, and calculation of metrics. Estimate review quality by running each candidate configuration independently `N` times per case and aggregating the scored samples.

## Product boundary and replay parity

Evaluation must preserve the production review contract:

- Review exactly `baseSHA...headSHA`.
- Capture the PR title, description, and base/head branch names on the trusted host and include the same immutable context in production and replay prompts.
- Start every sample in a fresh Amp orb for the mapped repository project. A transport retry may continue the same thread, as production does.
- Use `medium` mode and the production thread title, prompt builder, embedded two-pass ship-risk and simplicity methodology, retry behavior, and structured-output parser.
- Apply changed-line filtering and calculate the Check conclusion on the trusted host at fixed `FAIL_ON=high`.
- Never pass GitHub credentials to a review orb.
- Do not publish GitHub Checks or involve production webhooks, Postgres, queueing, or cancellation polling during an eval replay.

The shared path should be:

```text
exact frozen SHAs and PR context
  -> production buildReviewPrompt
  -> production executeReviewWithRetries in a fresh orb
  -> production parseReviewResult
  -> shared production finalizeReview(changedLines, FAIL_ON=high)
  -> retained findings and Check conclusion
  -> evaluation-only matching and scoring
```

Changed-line filtering and conclusion calculation currently live inside `GitHubClient.completeCheck`. Extract them into a pure production-owned function:

```ts
finalizeReview(
  result: ReviewResult,
  changedLines: ReadonlyMap<string, ReadonlySet<number>>,
  failOn: Severity,
): {
  result: ReviewResult
  omitted: number
  conclusion: "success" | "neutral" | "failure"
}
```

`GitHubClient.completeCheck` and the eval replay runner must both consume this function. This is the parity guarantee for retained findings and conclusions; evaluation code must not reimplement either policy.

`executeReviewWithRetries` exposes an optional generic message observer. Evaluation uses it to record observed model IDs while the normal thread callback records the thread ID; duration is measured by the runner. Richer attempt, turn, and token metadata can wait until the SDK exposes a stable need for it. No eval-specific type or behavior belongs in the production worker.

### Shared PR context

Production currently discards the PR title and description from the webhook and sends only repository identity, PR number, and SHAs to the reviewer. Add one shared context contract:

```ts
type PullRequestContext = {
  title: string
  body: string | null
  baseRef: string
  headRef: string
}
```

The webhook host captures these values with the reviewed SHAs, validates and bounds their lengths, and persists them with the review job. Re-runs reuse the stored snapshot rather than fetch mutable current PR state. `buildReviewPrompt` renders this context in an explicitly untrusted data block before the review instructions and tells the reviewer that it must not override the trusted exact-SHA target, methodology, security instructions, or output schema.

Eval cases store the same contract and call the same prompt builder. Control, advisory, and blocking variants from one seed all receive identical inherited PR context so the injected code is the only input difference. The rendered context and its hash are part of run provenance.

Do not include first-review comments in the production review input: they did not exist before that review and are used only as curation evidence. Commit messages are already available from the exact repository history. Labels, reactions, current CI state, later comments, and linked-issue expansion remain out of the first slice unless production later adopts them and replay follows.

## Corpus construction

### Seed snapshots

A seed is a real historical pull-request revision immediately before its first submitted non-bot human review. Record:

- Repository and pull-request number.
- Exact base and head SHAs.
- Cutoff timestamp.
- Title, body, draft state, and base/head branch names visible at the cutoff.
- Archived changed-line map and the patch or API response hash from which it was derived.
- Evidence that both SHAs are reachable in the eval Amp project.
- Snapshot provenance and curation model provenance.

Historical context is archived and passed through the same `PullRequestContext` prompt path as production. It must represent the state at the cutoff, not the PR's current title or description.

Prefer snapshots whose exact first-review state can be established directly. Reject ambiguous history rather than silently substitute the final PR revision, a branch tip, a different merge base, or current PR metadata. An unreachable case is excluded before suite membership is frozen. A previously eligible case that later becomes unavailable remains a reported availability failure and cannot silently leave a comparison.

No Buildsworth data or access is required.

### Automated control certification

For each candidate seed:

1. Run two independent stronger-model reviews in fresh full-repository orbs, initially blind to historical review comments.
2. Run one stronger-model adjudicator with both reviews, the exact diff and relevant source context, and first-round human comments as non-authoritative evidence.
3. Accept the control only if both reviews find no material introduced issue and the adjudicator explicitly certifies it as clean.

Comments can identify candidates but are never labels by themselves. Their absence proves nothing. Controls are called **teacher-certified clean**, not human-verified or truly clean.

### Mutation generation

Generate two separate commits from each accepted control head: one advisory and one blocking. The mutation generator receives the exact diff and surrounding repository context and must produce one realistic failure in code relevant to the original change.

An accepted mutation must:

- Introduce exactly one intended causal failure.
- Compile and pass the repository's selected ordinary checks so the defect is not a trivial build failure.
- Point to a line changed in the synthetic `baseSHA...headSHA` target.
- Avoid conspicuous comments, dead code, or naming that reveals the injection.
- Preserve unrelated behavior.
- Have an independent stronger-model verifier confirm the failure mechanism and expected severity.
- Have a hidden witness when practical that passes on the control and fails on the mutation.

The hidden witness is stored outside the reviewed commit and executed in a disposable, no-secret environment. It may be a test patch, focused command, or deterministic reproduction. A mutation without an executable witness needs stronger independent evidence and is marked `llm-verified`; metrics should distinguish it from `executable` mutations.

Mutation classes should vary across language, subsystem, and failure mode. Useful classes include swallowed errors, missing validation or authorization scope, retry or idempotency mistakes, cancellation loss, boundary and unit errors, resource lifecycle failures, and synchronization mistakes. Do not fill the corpus with repeated syntactic variations of one mutation operator.

Synthetic commits live only in private eval mirrors or immutable eval refs that the mapped Amp projects can fetch. They must never be merged into product branches.

### Frozen failure cards

Each mutation has a versioned reference card:

```ts
type FailureCard = {
  id: string
  kind: "advisory" | "blocking"
  severity: Severity
  rootCause: string
  failureBehavior: string
  path: string
  changedLine: number
  evidence: string[]
  verification: "executable" | "llm-verified"
  witnessArtifactHash?: string
}
```

The expected Check conclusion is derived from the card's severity with the production `checkConclusion` logic. It is not maintained as a second independent label.

## Replay and adjudication

### Production review samples

The replay command schema-validates the frozen coordinates and archived changed-line maps, invokes the shared production path, and writes one immutable artifact per sample. Reachability is certified when a case enters the corpus; a later checkout failure is retained as an operational failure rather than silently dropping the case. Each artifact contains:

- Corpus version, seed and case IDs, and the complete frozen expected label.
- A hash of the complete parsed corpus.
- Exact repository, project, base SHA, and head SHA.
- Frozen PR context and archived changed-line map through the hashed corpus.
- Bot commit, rendered prompt hash, review-source hash, and methodology hash.
- SDK version, `medium` mode, fixed failure threshold, observed model IDs when the SDK emits them, thread ID, timing, concurrency, and timeout.
- Raw final assistant output.
- Parsed result or schema/operational error.
- Retained and omitted findings and production conclusion.

Timeouts, checkout failures, exhausted retries, and invalid output have no semantic conclusion. They count as incorrect for conclusion agreement and separately against operational completion. They must never receive accidental credit as `failure` on a blocking case.

### Finding matching

Score only findings retained by the production finalizer.

Two independent structured matcher calls compare each retained finding with the frozen failure card. A third adjudicator resolves only disagreements. The first implementation returns the matching finding indexes; its cache and run artifact record the judge version, mode, SDK version, project, prompt hash, schema hash, vote position, and any observed model IDs.

The eventual adjudication output is one of:

- `match`: the finding describes the injected root cause and failure behavior.
- `duplicate`: another retained finding already matched the same injected issue.
- `unmatched`: it does not describe the injection.
- `unresolved`: the matcher evidence is insufficient.

Matching is semantic and does not compare title or prose similarity. One prediction can recall at most one injected issue, and an injected issue is recalled at most once per sample. Duplicate findings remain in the precision denominator.

Cache the resolved mapping by the complete review output, failure-card version, context hashes, matcher prompt and schema hashes, model/configuration provenance, and judge ordering. Never rejudge an identical artifact. Record initial judge disagreement rate as an eval reliability diagnostic.

For the small initial corpus, the reported **injection-precision proxy** gives at most one unit of credit for matching the injected issue and keeps all retained findings in the denominator. It is not yet a general precision or false-positive estimate. Before promoting a candidate, inspect any extra retained finding and resolve it as `false-positive`, `duplicate`, `novel-valid`, or `unresolved`; a candidate with an unresolved extra finding cannot advance. If extras become common, automate that classification with two stronger-model reviews and a third only on disagreement. A `novel-valid` issue retires a teacher-clean control or creates a new corpus version; it is never silently turned into a false positive or added around one candidate's result.

The deterministic scorer reads only frozen case data and cached judgments. It performs no model calls. This makes rescoring a fixed set of sampled reviews repeatable; it does not make the reviews or initial judgments deterministic.

## Metrics

Score every independent review sample first. For each case, calculate the mean of its `N` sample scores and retain the full distribution. Aggregate those case means so increasing `N` does not give one case more weight. Cases from the same control/advisory/blocking triplet share a seed and should remain visibly grouped rather than be presented as independent historical PRs.

Do not average JSON, severity names, or finding text. For categorical conclusions, average the binary indicator that the conclusion agreed with the reference and report the observed `success`/`neutral`/`failure` proportions.

- **Injected-issue recall:** fraction of mutations whose failure was matched. Report by advisory/blocking class and verification type.
- **Injection-precision proxy:** average per-sample credit for the one injected issue divided by retained findings. Duplicates and unrelated findings remain in the denominator. Do not call this population precision until unmatched findings are independently classified.
- **Teacher-certified-clean alert rate:** fraction of control samples with any retained finding, plus findings per control.
- **Severity calibration:** confusion matrix against failure-card severity and over-/under-blocking rate at `FAIL_ON=high`. Exact severity is diagnostic; crossing the production threshold is what changes the verdict.
- **Raw conclusion agreement:** production conclusion equals the control/advisory/blocking reference conclusion.
- **Grounded conclusion agreement:** the conclusion is correct because a retained finding matched the injected issue at the appropriate threshold. An unrelated high-severity finding cannot earn grounded failure credit.
- **Stability:** per-case conclusion distribution, score variance, and injected-issue detection frequency across repeated fresh runs, reported as `0/N` through `N/N`.
- **Operational completion:** successful execution and schema parsing rate.
- **Changed-line diagnostics:** number and severity of findings omitted by production filtering.
- **Judge reliability:** two-judge disagreement and unresolved rates.

The primary promotion signal is per-case grounded conclusion agreement. `severityThresholdAgreement` is conditional on detection and is diagnostic only; it must not hide missed issues or judge failures. All quality metrics must be described as agreement with controlled or LLM-adjudicated references. Do not claim human-ground-truth accuracy, population false-positive rate, statistical significance, or general code-review quality.

### Plain-language report

The saved run keeps the detailed measurements and exact evidence above, but the normal CLI report should answer simpler questions: did every review run, did expected-clean code stay quiet, was the known bug found, was the response appropriate, and were repeated runs consistent?

Use `check`, `run`, and `report` as the visible commands. Show counts such as “2 of 3,” not percentages alone. Group the three code versions from each historical pull request together, distinguish finding a bug from responding with the right urgency, and end with a direct summary plus the number of code versions and review runs. Every report must say that it covers only the included examples and is not a general quality claim. Technical field names and complete evidence remain in the private saved run rather than dominating terminal output.

## Suites and iteration workflow

The minimum useful comparison set contains three triplets: the existing concurrency seed plus two teacher-certified executable seeds, including examples from both repositories and two distinct non-concurrency blocking mechanisms. Keep the existing triplet visible for prompt debugging and freeze the other two before tuning. This is a confirmation slice, not a statistically meaningful holdout.

After the three-triplet loop proves useful, expand the initial regression corpus to eight triplets: four seeds from each repository, each with a control, advisory mutation, and blocking mutation. Assign four triplets to visible tuning and four to a sealed holdout before inspecting candidate results.

Use three execution tiers. `N` is part of the run manifest and fixed before execution; start with `N=3` and adjust only after measuring runtime and observed variance:

1. **Smoke:** one fresh sample over a representative visible subset during prompt iteration. This is a cheap directional signal, not evidence for promotion. Target no more than four triplets, and reduce further if measured runtime demands it.
2. **Candidate evaluation:** run every visible case `N` times after selecting a candidate. Report means and distributions; do not majority-merge findings into a synthetic review.
3. **Holdout:** after the prompt/model candidate is locked, run every sealed case the same `N` times. A single holdout sample is not enough for a promotion claim.

Archived accepted-baseline artifacts are sufficient for smoke comparisons and rescoring. For a promotion comparison, run the accepted baseline and candidate with the same `N` in an interleaved execution cohort unless an exact provider model snapshot and decoding configuration are pinned. This prevents time or provider drift from being mistaken for a prompt improvement. Never replace a failed sample with a selective rerun; a later attempt is an additional recorded sample.

Interpret each case independently. At `N=3`, `3/3` grounded conclusions is a provisional pass, `2/3` is unstable and expands both baseline and candidate uniformly to `N=5`, and `0/3` or `1/3` is a case failure. At `N=5`, only `4/5` or `5/5` permits advancement to a larger corpus. These are screening rules, not confidence intervals or reliability claims. Do not add samples only for favorable cases or stop when a preferred result first appears.

A candidate advances only if it fixes its predeclared target, introduces no case-level regression, has no unresolved extra finding, and the execution cohort is operationally complete. Never aggregate away one bad case behind suite averages.

If detailed holdout results drive another prompt change, move the exposed cases into tuning and replenish the holdout before making another holdout claim.

Normal CI runs deterministic parser, finalizer, schema, scorer, and cache tests only. Live Amp replay is manual or scheduled because it is stochastic and incurs external cost. Use bounded concurrency, initially two, and record timing before changing suite sizes.

## Storage, privacy, and security

The corpus contains internal source context, PR metadata, synthetic defects, model output, and potentially reviewer identities. Store actual corpus and run artifacts in a private, versioned eval-data repository or controlled object store; keep only schemas and synthetic test fixtures in amp-reviewbot.

- The replay process reads pre-archived metadata and requires no live GitHub credential.
- Host-side curation may use GitHub credentials, but only retrieved text and patches enter curation prompts; credentials never do.
- Use private Amp thread visibility and archive review and curation threads after artifacts are captured.
- Run generated witnesses and repository checks in disposable environments without production or workspace secrets.
- Do not print internal patches or model output to public CI logs.
- Treat all repository, PR, comment, and generated mutation content as untrusted input to the curation and review prompts.

## Implementation slices

### Slice 1: replay and scoring harness

Build and verify the production-parity path before creating external synthetic commits:

1. Freeze PR context with production jobs and render it through the shared prompt.
2. Extract and test the pure production finalizer without changing Check behavior.
3. Add a small corpus schema for exact SHAs, context, changed lines, and one known issue.
4. Replay every case `N` times using the production prompt, executor, parser, and finalizer.
5. Add cached two-judge matching with disputed-only adjudication.
6. Calculate case-level means and distributions offline.
7. Verify the corpus format, scorer, production executor settings, and CLI without starting live orbs.

This slice stops before mutation generation because synthetic SHAs require a configured private eval mirror. It is complete when the example corpus validates and typecheck, tests, and build pass.

### Slice 2: one end-to-end triplet

- Configure the private eval mirror and Amp project.
- Select and certify one historical control.
- Generate one advisory and one blocking mutation.
- Validate both hidden witnesses and persist the synthetic SHAs.
- Run each target `N` times and inspect the first real report.

This slice is complete when the three exact targets replay in fresh orbs and produce per-sample outcomes, means, distributions, raw and grounded conclusions, injection matching, precision, severity, provenance, and operational status.

Current status: complete. The first teacher-certified triplet lives in a private mirror Amp project; its control and two mutations are reachable by exact SHA in fresh orbs. Both hidden witnesses discriminate only their intended mutation, and selected visible tests pass on every target. A local reviewer run remains unsafe because an empirical probe confirmed that shell tools can see host credentials.

The first production-parity replay ran all three cases three times at concurrency two in 17 minutes 41 seconds. Operational completion was 9/9. The control stayed clean 3/3, both injected issues were found 3/3, every retained finding matched, and both matcher votes agreed. Grounded conclusion agreement was control 3/3, advisory 2/3, and blocking 0/3: one advisory run over-rated the issue as high, while every blocking run under-rated the independently verified high issue as medium. This is a useful baseline and a verdict-calibration failure, not a reason to relabel the mutation. The SDK did not emit reviewer or judge model IDs during this run, so those arrays are empty. That first artifact records SDK version, source and methodology hashes, and review prompt hashes; explicit corpus and judge-contract hashes were added after inspecting the baseline and apply to subsequent runs.

### Slice 3: initial regression corpus

- First add two varied executable triplets for the nine-case confirmation slice.
- If that loop is useful, generate and verify five more triplets for the 24-case regression corpus.
- Balance mutation classes and repository coverage.
- Assign visible and sealed-holdout membership before prompt tuning.
- Add bounded parallel execution and accepted-baseline comparison.
- Record actual runtime, mutation rejection rate, judge disagreement, and unresolved rate; add token accounting only when the SDK exposes it reliably.

### Slice 4: harden only from observed needs

- Add more seeds only when the first 24 cases fail to cover an observed production failure mode.
- Add naturally occurring, stronger-model-adjudicated historical issues as a reality check after the mutation loop proves useful.
- Add human spot audits only if confidence in a particular reference or judge class becomes a practical blocker.
- Design a statistically credible benchmark separately if product decisions later require population-level claims.

## Expected files and interfaces

Production changes:

- `src/types.ts`: add `PullRequestContext` and persist it on `ReviewJob`.
- `src/server.ts`: validate and capture title, description, and branch names from the signed webhook payload.
- `src/database.ts` and `migrations/002_review_context.sql`: apply the new ordered migration, persist the immutable context, and copy it on Check re-runs; existing jobs may have no context and omit the prompt block.
- `src/review.ts`: add `finalizeReview` and shared conclusion types if needed.
- `src/review.ts`: render bounded context as untrusted data in `buildReviewPrompt`.
- `src/github.ts`: make `completeCheck` consume `finalizeReview`.
- `src/worker.ts`: expose a generic message observer so the eval can record model provenance without duplicating execution.
- `test/server.test.ts`: webhook context capture and bounds.
- `test/database.test.ts`: context persistence and re-run snapshot reuse.
- `test/review.test.ts`: finalizer and conclusion behavior.
- `test/review.test.ts`: prompt context rendering, absent legacy context, and untrusted delimiter-like content.
- `test/github.test.ts`: prove unchanged Check payload behavior.
- `test/worker.test.ts`: unchanged fresh-orb settings and retry semantics.

Evaluation-only additions:

- `eval/schema.ts`: corpus, mutation, run, and judgment schemas.
- `eval/run.ts`: validation, production-path replay, and artifact writing.
- `eval/judge.ts`: cached two-vote matching and disputed-only third votes.
- `eval/score.ts`: offline metrics.
- `eval/README.md` and `eval/corpus.example.json`: usage and corpus format.
- `test/eval.test.ts`: schema, provenance, repeated aggregation, grounded conclusion, and operational failure cases.
- `package.json` and `tsconfig.json`: eval command and TypeScript inclusion.

Keep mutation generation and witness orchestration outside the replay harness until repeating the manual workflow shows a stable interface worth automating.

Do not add eval tables to the production database or make production queue, webhook, or GitHub publication code depend on evaluation modules.

## Verification criteria

- Existing typecheck, test, and build commands remain green.
- Production webhook ingestion freezes title, body, and branch names with the exact SHAs, and a Check re-run cannot pick up later PR edits.
- Replay and production produce the same rendered prompt for the same `ReviewJob`, including context containing delimiter-like or instruction-like text.
- GitHub Check output is byte-for-byte equivalent for representative retained and omitted findings before and after finalizer extraction.
- Replay invokes a new orb thread for every sample with the same project, `medium` mode, rendered prompt, methodology, parser, retry policy, and finalizer used in production.
- A high finding on an unchanged line is omitted and cannot fail an eval or production Check.
- Operational or schema failure cannot receive semantic failure credit.
- The hidden witness passes on the control and fails on its mutation; ordinary selected checks pass on both.
- Pure judge tests cover disputed-vote resolution. Matching quality is inspected on the first real triplet before corpus expansion; live model calls are not part of normal CI.
- Scoring an existing run is deterministic and makes no network or model calls.
- Each case is sampled exactly the manifest's declared `N` times; aggregation averages scored samples within a case before aggregating cases.
- Baseline and candidate promotion runs use the same `N` and are interleaved when model execution cannot be exactly pinned.
- Changing the failure card, candidate findings, judge prompt/version/mode, or vote position invalidates the judge cache key. Reviewer and corpus provenance remains embedded in the immutable run artifact.
- One complete triplet produces inspectable immutable artifacts, per-sample distributions, and the expected success/neutral/failure reference conclusions before corpus expansion.

## Assumptions and unresolved decisions

Assumptions:

- Both repositories can be represented in a private mirror Amp project with immutable synthetic eval refs.
- Fixed `FAIL_ON=high` remains the evaluation threshold.
- Stronger-model curation and judging are acceptable substitutes for routine human labeling, provided metrics are labeled accordingly.
- Model snapshots and decoding may not be fully pin-able through Amp; observed model IDs, prompt hashes, repeated production runs, cached judgments, and corpus versioning provide the practical reproducibility boundary.

Resolved for the first triplet:

1. Synthetic revisions live in private immutable mirror refs; private corpus, witnesses, and run artifacts stay outside this repository.
2. Reviewer samples use production `medium` mode; certification and finding matching use independent stronger reviews, with the matcher fixed to `high` mode.
3. The seed report freezes historical reconstruction evidence, visible test commands, independent certification, and hidden witness hashes.
4. Screening uses the predeclared per-case `N=3`/`N=5` rules above, with grounded production-threshold correctness as the gate and exact severity as a diagnostic.

Unresolved product decisions:

1. Which two non-concurrency seeds form the confirmation slice and which mutation classes they cover.
2. How long private run artifacts and archived review/judge threads should be retained.
3. Whether the SDK can expose stable underlying model and token provenance; until then, empty observed-model arrays are explicit rather than guessed.
4. Promotion thresholds for the eventual eight-triplet corpus, which should be set only after measuring baseline variance across those cases.
