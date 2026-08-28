# Review evaluation

This evaluation answers three practical questions:

1. Does the reviewer leave clean code alone?
2. Does it find a known bug?
3. Does it block only when the bug is serious?

Each example has three code versions: one expected to be clean, one with a smaller bug, and one with a serious bug. The bugs are checked independently and normally have a focused test that proves the failure. The reviewer never sees those tests or the expected answers.

Real example files and saved runs contain private source information. Keep them outside this public repository. `corpus.example.json` only shows the file format.

## Check the example file

This checks the file locally without starting any Amp reviews:

```sh
npm run eval -- check /private/path/examples.json
```

## Run the reviews

Run every code version three times:

```sh
npm run eval -- run /private/path/examples.json --samples 3
```

Every review runs in a fresh private Amp orb using the same prompt, JSON checks, changed-line rules, and `FAIL_ON=high` decision as production. Two independent Amp checks decide whether a finding describes the known bug; a third is used only when they disagree.

The command shows progress, prints a plain-language report, and saves the complete results under `.eval-runs/`. By default it runs two reviews at a time. Use `--concurrency`, `--output`, or `--timeout-minutes` to change those defaults.

## Read a saved report

```sh
npm run eval -- report .eval-runs/RUN.json
```

This makes no model or network calls. It checks the saved data again and prints counts such as:

```text
Review evaluation: NEEDS WORK

1 clean change, 1 smaller bug, and 1 serious bug.
Each was reviewed 3 times. All 9 reviews completed.
A right response reports a smaller bug without blocking, and blocks a serious bug.

Example 1 (pull request #1234)
  Clean change: 3 of 3 completed reviews had no false alarms
  Smaller bug: found in 3 of 3; right response in 2 of 3
  Serious bug: found in 3 of 3; right response in 0 of 3

Bottom line
  The reviewer found every known bug, but did not always respond with the right urgency.

Evidence: 3 code versions and 9 review runs.
This result covers only these examples; it is not a general quality claim.
```

The complete saved file retains the exact code revisions, pull-request context, reviewer output, matching decisions, tool versions, and detailed measurements for later inspection.

Interpret repeated runs before looking at the result: three correct results out of three passes this small set; two out of three means run both the current and proposed reviewer five times; zero or one means the reviewer needs work on that example. With five runs, only four or five correct results pass. These are practical comparison rules, not proof of general review quality.
