# Review-quality evaluation

## Goal

Give us a fast, credible way to improve amp-reviewbot without pretending an LLM is deterministic or comparing review prose.

**Status:** pack validation, research-enabled review runs, evidence retention, scoring, and offline reporting are implemented. The reviewer gets production-like public research access but must use only the supplied frozen snapshot for the target repository and must not inspect the target pull request. This is an instructed and audited protocol, not an adversarial security boundary.

For each exact code version, measure:

- whether the final result is `success`, `neutral`, or `failure` at `FAIL_ON=high`;
- whether each known material issue was found;
- how many findings did not match a frozen issue label and therefore need source checking;
- whether severity crossed the right blocking threshold; and
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

`example.json` contains public pull-request context once, followed by one or more exact code versions. It records whether the example is a pilot, human review, or synthetic change, and whether it is used during development or held back. Each version has `knownIssues`. A version with no frozen labels has none. An issue records its cause, failure behavior, severity, category, changed location, and verification evidence.

This handles both benchmark groups:

- a historical pre-fix revision where a non-author human review requested a concrete change and independent evidence confirms the issue; and
- a directly checked baseline revision plus one direct child commit containing a single deliberately introduced issue, normally paired with focused evidence. Source-confirmed baseline issues retain the same semantic card in both versions while their exact source line may move; the child adds exactly one issue.

Behavioral defects and maintainability advisories are distinct. Substantial duplicated logic can be a medium advisory when it has a concrete divergence cost. Non-idiomatic Go is low and requires official guidance or a dominant repository convention. Neither is described as a behavioral bug.

Approval, merge, draft status, and silence are never labels. A baseline must be checked directly. LLM-checked labels are described as such rather than called human ground truth.

## Run path

The enabled run path is:

```text
private example pack on the trusted machine
  -> verify exact source and calculate changed lines
  -> send every version through the same neutral source-snapshot path with public PR context
  -> parse and filter with production code
  -> use trusted matching calls to compare findings with known issues
  -> calculate and save counts
```

Production and evaluation share:

- the exact `base...head` target;
- frozen title, description, and branch names;
- a fresh Amp orb in `medium` mode;
- the production prompt and embedded two-pass review method;
- retry and JSON parsing behavior; and
- changed-line filtering and conclusion calculation.

The runner does not publish Checks, use production queueing, or give corpus credentials to a review orb.

The trusted runner verifies any delivered Git bundle, then makes a fresh source-only bundle for every target, public or private. Every review starts in a clean no-project orb with an empty workspace and receives the same neutral preparation block and reference names. The preparation creates a repository containing only the exact public base and target history, checks out the exact head, and removes the Git remote. Project setup, repository instructions, prior refs, reflogs, and future objects are never loaded. Known issues and focused tests do not enter the transfer.

The reviewer runs the complete fail-fast preparation block as its first successful tool call, then uses only that snapshot for the target repository. It is explicitly prohibited from inspecting the target pull request through GitHub pages or APIs, or from cloning, fetching, or inspecting another copy of the target repository. Public documentation, package registries, dependencies, other repositories, and delegated research that preserves this restriction are allowed.

Full traces diagnose skipped or altered preparation and observable target-source lookups. A violation marks the run contaminated. This audit cannot detect every concealed lookup through arbitrary child processes. We accept that possibility as a deliberate trade-off for parity with the research-capable environment available to a real reviewbot run. The benchmark measures a cooperative research-enabled reviewer, not resistance to deliberate benchmark cheating, and must not be described as adversarially blind.

The runner rejects a generated source-only transfer over 64 KiB. This keeps repeated reviews bounded and makes an oversized synthetic example a clear pack error instead of an unexpectedly slow or expensive run.

## Account boundary

The example pack stays with the trusted account. The trusted process and matching orbs use the authenticated local Amp CLI. Reviews require a separate identity:

- `AMP_EVAL_REVIEWER_API_KEY`: separate review account, used only by the review child process.

The runner validates that key and stores only a hash of its Amp user ID. The review child gets a new empty home directory and an allowlisted environment while matching continues through the local login. Before a run, the operator must confirm that the review identity cannot access the private example pack.

`AMP_API_KEY` is rejected so it cannot silently replace the local CLI login. Two projects owned by the same account are not an account boundary.

## Repeated runs

Run each version independently three times in reproducibly shuffled repeat blocks. Each block contains every selected version once, and the artifact records the random seed and exact start order. Do not average review text. Score each run as facts such as “issue found” and “right final result,” then aggregate at the pull-request seed.

Use a rule chosen before seeing results:

- 3 of 3 seed votes: provisional pass for this small set;
- 2 of 3 seed votes: unstable;
- 0 or 1 of 3: needs work on that example;
- at five runs, require at least 4 of 5.

Never replace a failed run or add runs only where the preferred version is behind. When comparing two reviewer versions, run both over the same examples and repeat count close together in time.

For a synthetic seed, one seed vote matches only when the baseline and introduced version both match in the same repeat. A baseline with source-confirmed inherited labels is judged against those labels rather than being called clean.

Model matching is also non-deterministic. It starts only after all reviewer calls have finished and a private completed-review checkpoint has been saved. It uses a separate timeout, so matching latency or interruption cannot erase completed reviews. Two independent high-mode calls check each known issue against the retained findings. A third is used only when the first two disagree. Identical checks are cached. The saved run records the votes and their complete prompt, schema, SDK, mode, model information, and phase timing.

## What the report means

The main report answers:

- did every review finish;
- did versions with no frozen issues avoid clean alerts;
- was each known issue found;
- was the final response appropriately urgent; and
- were repeated runs stable?

Saved JSON keeps exact commits, context, changed lines, every complete review and matching prompt, matching response schemas, full SDK tool traces, model IDs, raw output, filtered findings, conclusions, matching votes, code hashes, separate review/matching timing, execution order, the protocol identifier, a target-source audit, and errors. Re-reading a saved report makes no model or network calls. New runs report `RESEARCH-ENABLED`; a target-source violation makes their recorded result `CONTAMINATED`. Historical artifacts without the new protocol identifier remain `DIAGNOSTIC ONLY`. The artifact is private and potentially sensitive.

If matching fails after reviews finish, `npm run eval -- finish RUN.json` retries only the missing matches through the local CLI login. It writes a new file, preserves the original review evidence and timing, and records the exact hash of the source file. It does not rerun reviews or use the separate review-account key.

One finding can match at most one known issue, and one known issue can be counted at most once per review. Extra findings stay visible as unmatched findings that need source checking. Do not call the matched-finding fraction precision. A conclusion receives frozen-label credit only when all known issues for that version were found at the correct side of the blocking threshold.

## Scientific limits

The first open pack is a regression set for iteration. It is not a representative population sample.

The pilot remains separate because its outcomes have already been observed. The frozen benchmark adds 60 different source pull requests: 30 exact human-reviewed revisions and 30 baseline/synthetic pairs. Ten from each group are held back before any review run. Source-PR membership, labels, issue cards, and rejection reasons freeze before tuning.

Because LLMs create and check most labels, report agreement with the labeled examples, not “true accuracy.” Audit every unmatched finding before classifying it. If a review finds a real bug missing from the pack, repair the baseline label (and repeat it in both synthetic versions) rather than count the finding as a false alarm. Keep this later source adjudication separate from the frozen metrics.

## Before a run

1. Keep the example pack private and confirm the separate reviewer identity cannot access it.
2. Validate that each supplied snapshot has only the permitted base and target histories and no remote.
3. Freeze the corpus, split, prompts, mode, repeat count, and matching rules before running a development sample.
4. Ask for explicit confirmation before any smoke, development, or holdout run.

## Verification

- Normal typecheck, tests, and build pass without live Amp calls.
- A local Git fixture proves source commits, bundles, changed lines, and issue anchors are checked. Synthetic issues must be introduced by one direct child commit and point to a line changed by that commit; inherited baseline semantics must be identical while source lines may move.
- Every generated review source bundle contains one target ref and no known-bug or witness data; every version receives the same neutral preparation shape.
- The runner uses local CLI authentication by default; when a review key is supplied, the review child receives only that key and basic connection settings.
- Production prompts are unchanged when no eval source preparation is supplied.
- Saved runs reject altered corpus evidence, invalid finding indexes, conclusions that do not follow from raw production output, review or matching prompt/schema hash drift, missing full prompts/traces, phase-timing drift, and execution-order drift. They preserve the original audit while reports apply the current audit separately, so improved detection does not make an unchanged artifact unreadable.
- Interrupted matching can finish into a new traceable result without changing or rerunning saved reviews.
- One finding cannot earn recall for two known issues.
- A run requires a separate review-account key and records the research-enabled target-frozen protocol.
- Public dependency and documentation research is allowed, while observable access to the target PR or an external copy of the target repository is marked contaminated.
