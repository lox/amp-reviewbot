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

## Noise floor

`current` on identical inputs: fast-v1 four times, 9–11/11 blocking and 1/5 wrong (#4015 flipped in 3 of 4 runs, #2759 blocked every time). fast-v2 once against its selection run, 6/8 to 7/8 blocking and 5/8 to 4/8 wrong. Treat one flipped call in either direction as noise; the rule's thresholds already do.

## What the log says so far

Three prompt-wording attempts at severity calibration (tightened high, scope gate, severity calibration gate) each lowered blocking detection by one to three calls while leaving the persistent wrong blocks in place. The reviewer's severity judgement on #2759, #3820, and #3931 has not moved under any wording. The next attempt at over-blocking should change the mechanism, not the wording: for example a separate severity pass over retained findings with the code in view, or accepting the current rate. On corrected labels the production prompt blocks 25/29 development and 17/18 holdout bugs and wrongly blocks 5/22 and 3/10.

## Label audit

On 2026-09-10 every version the pre-gate prompt wrongly blocked on the wide sets (34) was adjudicated offline against source. 26 were real high-severity bugs with stale or missing labels; a sceptical second pass lowered 3 of those back. 7 were false positives and 1 (#4028) stayed uncertain. The corpus went from 118 to 147 recorded issues, the development split from 21/7/32 to 35/6/19, and the holdout from 5/10/15 to 19/7/4. Saved artifacts were rescored rather than rerun.
