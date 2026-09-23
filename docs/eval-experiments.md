# Prompt experiment log

## Finding matcher validation

The original batched standalone Jev matcher was rejected: a typed probability did not make its unvalidated `0.8` threshold accuracy preserving. It remains available only to reproduce old matcher artifacts.

The replacement `jev-cascade-1` was frozen before evaluation: Jev 1.13.0, API v1, SDK 0.6.0, one minimal request per issue/finding pair, three independent relation/cause/failure questions, inclusive `0.90` match and `0.90`/`0.10` non-match boundaries, and whole-issue Amp fallback for any uncertainty or failure. Blind adjudication hid provider identity, scores, routes, severity, taxonomy, and source identifiers. No threshold, prompt, or policy changed between slices.

It passed all predeclared gates on three slices:

- Historical development: 362 pairs and 267 issue units; 162 auto-resolved, 102 fell back, and 3 lacked a saved incumbent. The cascade and incumbent each made one wrong pair and exact-set decision on common adjudicated units, neither involving a blocking issue. It avoided 242 of 449 saved Amp votes (53.9%) and made no correct downstream outcome incorrect. This older-corpus slice is matcher evidence, not current reviewer accuracy.
- Corrected current development: 115 pairs and 84 issue units; 49 auto-resolved and 35 fell back. Blind adjudication found 0/54 pair errors and 0/42 exact-set errors for both matchers, with no blocking or downstream errors. It avoided 84 of 154 newly generated Amp votes (54.5%); the measured-usage cost projection was 54.5% lower, not a measured bill.
- Frozen corrected holdout A: 108 pairs and 45 issue units; 28 auto-resolved and 17 fell back. Blind adjudication found 0/59 pair errors and 0/28 exact-set errors for both matchers, with no blocking or downstream errors. It avoided 56 of 90 newly generated Amp votes (62.2%); the development-usage-based cost projection was 62.1% lower, not measured holdout spend.

Repeated samples were interpreted by source example, and no B/candidate holdout artifact informed the frozen run. These finite results support the cascade as an accuracy-preserving selective accelerator on the evaluated corpus; they are not a general accuracy claim. `amp` remains the CLI default so environments without TypeSafe credentials keep working, while `jev-cascade` is the recommended matcher for full reports.

One row per predeclared A/B. A row is written when the decision page is read, whatever it says. KEEP A and REGRESSION are finished experiments; do not rerun them with the same prompt. Blocking is "blocking versions blocked", wrong is "non-blocking versions blocked". Set compositions are the corrected labels at the time of the run.

| Date | Set | A | B | Blocking A / B | Wrong A / B | Verdict | Outcome |
|---|---|---|---|---|---|---|---|
| 2026-09-07 | fast-v1 (11/3/2) | pre-severity-guide | current (severity guide) | 5/11 / 10/11 | 0/6 / 1/6 | REGRESSION by rule | Guide had already shipped (#33); offline rescore of the 27-version screen confirmed 15/20 vs 10/20 with no wrong blocks, so it stayed. |
| 2026-09-07 | fast-v1 | current | tightened high wording | 10/11 / 10/11 | 1/5 / 0/5 | KEEP A | Removed #2759 but lost #4270 (documented default ten times too large). Not shipped. |
| 2026-09-08 | fast-v1 | current | intent check | 9/11 / 10/11 | 1/5 / 0/5 | KEEP A | A had one execution failure. More findings overall. Not shipped. |
| 2026-09-08 | fast-v1 | current | scope gate | 10/11 / 11/11 | 1/5 / 1/5 | KEEP A | Only candidate within the rule's reach; promoted to the wide set. |
| 2026-09-08 | fast-v1 | current | intent check + scope gate | 10/11 / 9/11 | 1/5 / 1/5 | KEEP A | Combining both lost two blocking calls. |
| 2026-09-09 | dev-all-v1 (21/7/32, stale labels) | current | scope gate | 18/21 / 19/21 | 18/39 / 12/39 | PROMISING (predeclared wide rule) | Shipped as #42 before the holdout ran. |
| 2026-09-10 | holdout-all-v1 (5/10/15, stale labels) | pre-scope-gate | scope gate | 5/5 / 5/5 | 16/25 / 17/25 | REGRESSION | Reverted in #44. Rescored on corrected labels the gate was a wash on both sets. |
| 2026-09-10 | fast-v2 (8/4/4) | current | severity calibration gate | 7/8 / 4/8 | 4/8 / 3/8 | REGRESSION | Lost #3825, #3964, #4015; removed only #3907. The three targeted wrong blocks (#2759, #3820, #3931) were unchanged. |
| 2026-09-11 | fast-v2 (8/4/4) | current (saved A artifact) | severity re-pass over its 11 blocked reviews | 7/8 / 6/8 | 4/8 / 4/8 | KEEP A | Re-pass kept all four wrong blocks at high and lowered one real finding (#3964 mutant, high to low) after reasoning that a later `wait` step would catch the failure. 9 minutes, 0 failures or violations. Not wired into production. |
| 2026-09-21 | fast-v2 (9/3/4, corrected after run) | current | effective-default trace | 6/9 / 7/9 | 4/7 / 4/7 | REGRESSION on frozen labels; KEEP A after source adjudication | Frozen labels made #3964 clean-control look like a new wrong block. Source reproduction established it as a real release-regex defect, making #3825 and #3964 gains against a #4015 loss. The corrected result still misses the PROMISING gate. No ship, confirmation, or holdout. |
| 2026-09-23 | severity-blocking-evidence-v1 (6/8/4 at freeze) | current | blocking path plus recovery evidence | 5/6 / 4/6 | 6/12 / 2/12 | REGRESSION by predeclared rule; generic page said KEEP A | Removed five frozen-label wrong blocks but added a #4339 wrong block and lost #4358. Source audit confirmed #4327 clean as another real blocking loss and corrected that inherited issue on both versions. No confirmation, holdout, or ship. |

## Noise floor

`current` on identical inputs: fast-v1 four times, 9–11/11 blocking and 1/5 wrong (#4015 flipped in 3 of 4 runs, #2759 blocked every time). fast-v2 once against its selection run, 6/8 to 7/8 blocking and 5/8 to 4/8 wrong. Treat one flipped call in either direction as noise; the rule's thresholds already do.

## What the log says so far

Three prompt-wording attempts at severity calibration (tightened high, scope gate, severity calibration gate) each lowered blocking detection by one to three calls while leaving the persistent wrong blocks in place. The reviewer's severity judgement on #2759, #3820, and #3931 has not moved under any wording, and the severity re-pass below (a change of mechanism, not wording) did not move it either. The later blocking-evidence experiment did move two newly targeted medium promotions, but it also promoted a focused test failure to high and suppressed independently reproduced blocking defects; making the proof obligation more concrete did not make it selective. With the later #3964 label correction, the production prompt blocks 25/30 evaluable development bugs and wrongly blocks 5/21 non-blocking versions; the remaining versions were excluded for rule breaking or never scored because the prepared source no longer matched the pack. The later #4110 clean-change high (see the miss audit) moves the holdout to 17/19 blocked and 3/9 wrong. Severity-suppression experiments are closed. None reached PROMISING on a fast set; the one wide-set PROMISING (scope gate) was a holdout REGRESSION and a wash after rescoring. `current` stays. The offline miss audit found a repeated effective-default evidence gap, but its targeted experiment traded two corrected blocking gains for one blocking loss and therefore finished KEEP A after source adjudication. A multi-sample majority remains unjustified because only #3825 was unstable across saved current-prompt runs.

## Blocking evidence trace (finished: REGRESSION)

Hypothesis (2026-09-23): the reviewer promotes real medium defects and unsupported claims because it
stops at an intermediate mismatch rather than establishing a supported production caller, an
unrecovered terminal consequence, and the absence of the strongest adjacent recovery path. Unlike
the earlier severity checklist and second-opinion re-pass, the candidate preserved finding
generation and required that evidence acquisition in the first review before a finding could remain
high. The development-only set retained both versions of nine independent source examples: six
blocking, eight clean, and four advisory-only versions at freeze. PROMISING required at least three
net wrong blocks removed, source-grounded improvement on two of three targeted medium promotions,
zero blocking loss, zero new wrong blocks, and no consequential execution or rule failure. Any new
wrong block or at least two blocking losses was REGRESSION.

All 36 paired reviews completed once with no retry, execution failure, or rule violation. On frozen
labels, A/B blocking was 5/6 versus 4/6 and wrong blocks were 6/12 versus 2/12: five wrong blocks were
removed, one was added, and one blocking call was lost. The generic evaluator page recorded KEEP A,
but the experiment's stricter rule makes the new #4339 wrong block a REGRESSION. The candidate did
correctly lower #4323 and #4327's medium optimization defect; it left #4355 high, promoted #4339
because its focused test fails in CI, and lowered the independently reproduced #4358 partial-mirror
failure.

Post-run source audit found a frozen label defect rather than improving the verdict. The incumbent's
#4327 clean-control finding was real: a focused Git reproduction showed that connectivity-only fsck
accepts a malformed reachable pack that full fsck and the subsequent reference clone reject. The
inherited high issue is now recorded on both #4327 versions without changing the registered decision
page. On corrected labels the set is 8/7/3; source adjudication gives A/B blocking of 6/8 versus 4/8
and wrong blocks of 4/10 versus 2/10. Candidate B missed the inherited issue. The #4287 and #4348
clean-control removals were correct, while #4323 and the default-flag part of #4327 were correct
severity reductions. The result remains REGRESSION, and the protocol stopped without confirmation,
holdout, or a reviewer change.

## Severity re-pass (finished: KEEP A)

Hypothesis (2026-09-11): a fresh thread that only re-rates the retained blocking findings, with the code in view and nothing else to find, lowers the wrong blocks (#2759, #3820, #3931, #3907) while keeping the real ones. `npm run eval -- repass PACK A.json` derives B from the saved fast-v2 A artifact (`2026-09-10T22-51-26-509Z-fast-v2-A.json`, 7/8 blocking, 4/8 wrong) by re-passing only its 11 blocked reviews, so the review side is held constant and the result isolates the re-pass. The same rule applies: PROMISING needs net wrong blocks removed of at least 2 with no net blocking loss; any blocking loss of 2 or a net new wrong block (impossible for a lower-only pass) is a REGRESSION. If PROMISING, repeat on the dev-all-v1 A artifact and then the holdout A artifact before wiring the re-pass into the production worker.

Result: KEEP A. With only the four wrong blocks in view and the code available, the re-pass confirmed every one of them as high; it found nothing to lower in #2759, #3820, #3931, or #3907. The one finding it did lower was real (#3964 mutant, "Release pipeline runs after failed tests"): the re-pass argued that a later `wait` step precedes the release triggers, which is the same kind of over-confident reasoning that produces the wrong blocks in the first place. Reading the four wrong blocks together with this result: the reviewer treats "a misconfigured or non-default input reaches a bad path" as high, and neither wording nor a second look changes that. The remaining levers are labels (whether those four are advisory is a product judgement; see the label audit), a rule-based check the model does not get to argue with (for example, evidence that the path is reachable from shipped defaults), or accepting the current wrong-block rate (5/21 development, 3/9 holdout on final corrected labels). The `repass` command stays in the eval as a measured negative result and a template for the next mechanism.

## Miss audit

On 2026-09-11 every blocking version `current` completed and did not block was read from the rescored artifacts, without model calls. A 2026-09-21 source reproduction then corrected #3964 clean-control from clean to blocking. Development, final labels: 36 blocking = 25 blocked, 5 missed, 1 excluded for rule breaking (#2807), 5 never scored because the prepared source no longer matched the pack (#4061 mutant, both #4101, #4239 mutant, #4270 mutant); evaluable denominator 30. Holdout, final labels: 20 blocking = 17 blocked, 2 missed, 1 excluded (#3871); denominator 19. The rescored holdout artifact predates the #4110 clean-change high, which is why the earlier record says 19 blocking and 17/18; #4110 is the added blocking version and the added miss.

| Version | Split | Class | What the review said |
|---|---|---|---|
| agent-3295-human/reviewed-change | dev | calibration | Described the exact coverdir-flag defect at the labelled line, rated medium. |
| agent-3464-human/reviewed-change | dev | detection | No finding about the Go 1.25 / macOS 11 support break. |
| agent-3825-synthetic-concurrency/clean-change | dev | detection (unstable) | No finding about the mutable-mirror dependency; blocked in 2 of 3 other `current` runs. |
| agent-3964/clean-control | dev | detection | No finding about the overescaped release regex; the effective-default candidate reproduced it, exposing the old clean label as incorrect. |
| agent-4270-synthetic-api-contract/clean-control | dev | calibration | Described the force-stop / graceful-report wait on another changed line, rated medium. |
| agent-3868-synthetic-concurrency/clean-change | holdout | detection | Only a separate medium negative-timeout finding. |
| agent-4110-synthetic-concurrency/clean-change | holdout | detection | No finding about replaying non-idempotent calls on the HTTP/2 failure. |

No miss was a changed-line filtering drop. Only #3825 flipped between `current` runs (the fast-set rows above that mention #4270 concern its mutant version, a different blocking version that `current` blocks; the miss here is its clean-control version, which no saved `current` run blocked), so the instability gate for a multi-sample majority A/B (at least three unstable development misses) is not met and that trial is off. The two calibration misses are the mirror image of the persistent wrong blocks: the reviewer describes the defect and places it on the wrong side of the medium/high line, in both directions. Prompt wording did not move that line for the wrong blocks and there is no reason to expect it to move for the misses. The development audit grouped #3464 and #3825 under failure to establish the effective default; #3964 added a related external-contract miss after its label was corrected. The targeted mechanism changed the intended evidence gathering but did not beat `current`, as recorded above. The two holdout detection misses remain distinct aggregate facts and did not inform the candidate.

Eval hygiene: the five development blocking versions dropped for a prepared-source mismatch (#4061 mutant, both #4101, #4239 mutant, #4270 mutant) had never been scored under `current`. On 2026-09-19 they were frozen as `sets/gap-v1.json` and an A/A run of `current` over exactly those ten reviews was started; its result is recorded here when it lands. #2807 stays excluded unless a rerun of it completes without breaking the rules.

## Label audit

On 2026-09-10 every version the pre-gate prompt wrongly blocked on the wide sets (34) was adjudicated offline against source. 26 were real high-severity bugs with stale or missing labels; a sceptical second pass lowered 3 of those back. 7 were false positives and 1 (#4028) stayed uncertain. The corpus went from 118 to 147 recorded issues, the development split from 21/7/32 to 35/6/19, and the holdout from 5/10/15 to 19/7/4 at the rescore; later adjudications added highs to #4110 clean-change and #3964 clean-control, making the final holdout 20/6/4 and development 36/5/19. Saved artifacts were rescored rather than rerun.

The last disputed wrong block, #3931 clean-control, stays advisory-only (one low functional issue). `current` blocks it on two highs: stable v4 builds routed to the beta release pipeline, and oldstable publishing moving container tags. At that commit both were deliberate: v4 stable handling was explicitly deferred to a later change, and the oldstable moving tags are the intended publication behaviour. The code was correct for what it set out to do, so the reviewer's block is a wrong block by design, not a stale label. It joins #2759, #3820, and #3907 as the persistent wrong blocks that no wording or re-pass has moved.
