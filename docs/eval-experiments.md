# Prompt experiment log

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

## Noise floor

`current` on identical inputs: fast-v1 four times, 9–11/11 blocking and 1/5 wrong (#4015 flipped in 3 of 4 runs, #2759 blocked every time). fast-v2 once against its selection run, 6/8 to 7/8 blocking and 5/8 to 4/8 wrong. Treat one flipped call in either direction as noise; the rule's thresholds already do.

## What the log says so far

Three prompt-wording attempts at severity calibration (tightened high, scope gate, severity calibration gate) each lowered blocking detection by one to three calls while leaving the persistent wrong blocks in place. The reviewer's severity judgement on #2759, #3820, and #3931 has not moved under any wording. The next attempt at over-blocking should change the mechanism, not the wording: for example a separate severity pass over retained findings with the code in view, or accepting the current rate. On corrected labels the production prompt blocks 25/29 development and 17/18 holdout bugs and wrongly blocks 5/22 and 3/10.

## Severity re-pass (finished: KEEP A)

Hypothesis (2026-09-11): a fresh thread that only re-rates the retained blocking findings, with the code in view and nothing else to find, lowers the wrong blocks (#2759, #3820, #3931, #3907) while keeping the real ones. `npm run eval -- repass PACK A.json` derives B from the saved fast-v2 A artifact (`2026-09-10T22-51-26-509Z-fast-v2-A.json`, 7/8 blocking, 4/8 wrong) by re-passing only its 11 blocked reviews, so the review side is held constant and the result isolates the re-pass. The same rule applies: PROMISING needs net wrong blocks removed of at least 2 with no net blocking loss; any blocking loss of 2 or a net new wrong block (impossible for a lower-only pass) is a REGRESSION. If PROMISING, repeat on the dev-all-v1 A artifact and then the holdout A artifact before wiring the re-pass into the production worker.

Result: KEEP A. With only the four wrong blocks in view and the code available, the re-pass confirmed every one of them as high; it found nothing to lower in #2759, #3820, #3931, or #3907. The one finding it did lower was real (#3964 mutant, "Release pipeline runs after failed tests"): the re-pass argued that a later `wait` step precedes the release triggers, which is the same kind of over-confident reasoning that produces the wrong blocks in the first place. Reading the four wrong blocks together with this result: the reviewer treats "a misconfigured or non-default input reaches a bad path" as high, and neither wording nor a second look changes that. The remaining levers are labels (whether those four are advisory is a product judgement; see the label audit), a rule-based check the model does not get to argue with (for example, evidence that the path is reachable from shipped defaults), or accepting the current wrong-block rate (5/22 development, 3/10 holdout on corrected labels). The `repass` command stays in the eval as a measured negative result and a template for the next mechanism.

## Label audit

On 2026-09-10 every version the pre-gate prompt wrongly blocked on the wide sets (34) was adjudicated offline against source. 26 were real high-severity bugs with stale or missing labels; a sceptical second pass lowered 3 of those back. 7 were false positives and 1 (#4028) stayed uncertain. The corpus went from 118 to 147 recorded issues, the development split from 21/7/32 to 35/6/19, and the holdout from 5/10/15 to 19/7/4. Saved artifacts were rescored rather than rerun.
