---
name: general-code-reviewing
description: Reviews code through independent ship-risk and simplicity passes, then synthesizes grounded findings. Use for pull requests, diffs, or ship-readiness reviews.
---

# General Code Reviewing

Review one concrete target with two independent passes—ship risk first, simplicity second—then return one concise, findings-first result.

## Establish The Evidence

1. Identify the exact PR, branch diff, staged diff, commit range, or named files. Use a fresh base revision and preserve any user-supplied focus.
2. Read the changed code and enough surrounding callers, tests, schemas, and operational boundaries to understand the intended behavior.
3. Compare with the previous behavior when reviewing a regression, refactor, or migration. Identify the invariants the old code preserved.
4. Inspect adjacent paths that can invalidate the happy path: retries, rollback, permissions, background work, migrations, caching, and concurrency.
5. Run targeted verification when it is safe and materially raises or lowers confidence. The review itself is read-only.
6. State material evidence gaps instead of filling them with speculation.

## Pass 1: Ship Risk

Try to disprove that the change is safe to ship. Assume subtle, expensive, or user-visible failures remain until the evidence rules them out. A change often carries several independent defects; finding one does not clear the rest of the diff, so keep going until every changed hunk has been checked. Report each grounded defect rather than a few weak suspicions, and do not give credit for intent or expected follow-up work.

Work in this order unless the caller requests a different emphasis:

1. Correctness and regression risk
2. Error handling and degraded dependencies
3. Data integrity and state transitions
4. Security and trust boundaries
5. Performance and scalability on realistic hot paths
6. Tests and observability gaps that would let a material failure ship unnoticed

Actively trace bad input, timeouts, retries, concurrent actions, stale state, re-entrancy, and partially completed operations. Look for violated invariants, missing guards, and assumptions that stop being true under stress. Prioritize:

- authorization, permissions, tenant isolation, and other trust boundaries
- data loss, corruption, duplication, and irreversible changes
- rollback safety, retries, partial failure, and idempotency
- race conditions, ordering assumptions, stale state, and re-entrancy
- empty, null, timeout, and degraded-dependency behavior
- version skew, schema drift, migration hazards, and compatibility
- hidden failures that would be difficult to detect or recover from

Adapt the attack to the change. For application code, stress state and error propagation. For infrastructure or configuration, stress blast radius, permissions, dependency ordering, rollback, secrets, drift, and cost. For schema or data-path changes, stress reversibility, backfills, partial rollout, dual reads or writes, and idempotency. For dependencies, stress provenance, install behavior, new access, permissions, and lockfile consistency.

## Pass 2: Simplicity

Start again from the same target rather than using the first pass as an agenda. Ask whether every line, concept, and layer in the diff earns its existence. The best code is code that does not need to exist; the next best replaces more concepts than it adds.

Find the lowest remedy that fully covers the present requirement:

1. Delete or defer speculative features, configuration, generality, or scaffolding with no current caller.
2. Reuse an existing helper, type, module, or repository pattern.
3. Use the standard library, platform, or an already-installed dependency.
4. Prefer a short idiomatic expression over bespoke machinery.
5. Add the minimum direct, boring code needed now.
6. Add structure only when it leaves the reader holding fewer concepts—for example, when it replaces real duplication, scattered feature checks, or confused ownership.

Flag grounded cases where the diff:

- adds an interface, factory, option, mode, or configuration value for one implementation or fixed value
- reimplements something already supplied by the repository, language, platform, or an installed dependency
- adds a dependency for a few clear idiomatic lines
- introduces thin wrappers, pass-through helpers, identity abstractions, or generic machinery that obscure a simple data shape
- adds booleans, nullable modes, fallbacks, casts, magic defaults, or scattered conditionals instead of an explicit model or contract
- puts feature-specific behavior in shared code or fixes one caller when the source of truth is the smaller correct boundary
- adds non-trivial behavior without the smallest useful check that would catch a regression
- relocates complexity without reducing the concepts a maintainer must understand

Indirection alone is not simplification, and file size alone is not a defect. Do not simplify away required validation, data-safety error handling, security, accessibility, operational observability, or behavior required by the change. Between equally small approaches, prefer the one that remains correct at the relevant edges.

## Finding Bar

Report only material issues that pass all four checks:

1. **In scope:** The issue affects the stated intent, changed behavior, a supported contract, or an established invariant, and identifies a changed file and precise line range.
2. **Concrete harm:** There is a reachable failure scenario under realistic conditions or a concrete maintenance burden, with a likely material impact.
3. **Introduced here:** The target change introduces the issue or materially worsens it, and the finding explains why.
4. **Actionable remedy:** The finding gives the smallest sufficient remedy for the concrete harm.

Drop anything that fails one of these checks. Maintenance burden counts as concrete harm only when it is specific: a duplicate source of truth, an ambiguous or impossible state, needless change surface, an abstraction with one implementation, feature-specific logic in shared code, or complexity relocated rather than removed.

Do not report adjacent pre-existing problems, speculative future concerns, tool-enforced style, defence in depth without a credible present threat, unrelated refactors, or a better design that corrects no concrete harm. Objective improvement alone is not a reason to ask for work.

Testing and observability gaps are findings only when they allow a specific material defect to ship or remain hidden. If repository context or tool output does not support a concern, omit it. Withdraw or downgrade suspicions disproved by broader context.

## Synthesize And Report

After completing both passes:

1. Deduplicate findings with the same root cause. Retain separate findings only when they describe materially different impacts or remedies. Do not drop a grounded finding because a stronger one already exists; the author needs every defect, not the worst one.
2. Resolve conflicts against the code and preserve correctness over deletion.
3. Order the surviving findings by severity.
4. Honor any caller-required output format. Otherwise include a verdict (`no-ship`, `needs-attention`, or `approve`) and findings with evidence, impact, and the smallest remedy.

Use `no-ship` for a critical or high ship risk or severe complexity that should not harden into the codebase. Use `needs-attention` for other material findings and `approve` when none survive synthesis.

If there are no findings, say so directly and mention only a material residual risk or verification gap. Do not expose pass transcripts or internal schemas.
