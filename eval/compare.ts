import type { EvalCase, EvalRun } from "./schema.js"
import {
  countLabel,
  excludeRuleBreakingReviews,
  fraction,
  scorecardLines,
  versionLabel,
} from "./report.js"
import { isRightEveryTime, scoreRun, type CaseScore, type EvalScore } from "./score.js"

type NamedRun = { name: string; run: EvalRun }

/**
 * Puts two saved runs side by side. Each version is compared with itself, so
 * an easier or harder version cannot tilt the result. A version counts as
 * shared only when both runs reviewed the same commits against the same
 * recorded issues; everything else is left out of every number shown.
 */
export function formatComparison(a: NamedRun, b: NamedRun): string {
  if (a.run.requestedSamplesPerCase !== b.run.requestedSamplesPerCase) {
    throw new Error(
      `cannot compare runs with different repeat counts: A reviewed each version ${a.run.requestedSamplesPerCase} times, B ${b.run.requestedSamplesPerCase}`,
    )
  }
  const casesA = new Map(a.run.cases.map((evalCase) => [evalCase.id, evalCase]))
  const shared: EvalCase[] = []
  let changed = 0
  for (const evalCase of b.run.cases) {
    const other = casesA.get(evalCase.id)
    if (!other) continue
    if (sameVersion(other, evalCase)) shared.push(evalCase)
    else changed += 1
  }
  const onlyOne = a.run.cases.length + b.run.cases.length - 2 * (shared.length + changed)
  const sharedIds = new Set(shared.map((evalCase) => evalCase.id))
  const scoredA = scoreShared(a.run, sharedIds)
  const scoredB = scoreShared(b.run, sharedIds)

  const leftOut = [
    onlyOne > 0 ? `${countLabel(onlyOne, "version")} in only one run` : "",
    changed > 0
      ? `${countLabel(changed, "version")} with different commits or recorded issues in the two runs (the runs used different example packs)`
      : "",
  ].filter((part) => part !== "")
  const lines = [
    `A: ${a.name}`,
    `   reviewer ${describeReviewer(a.run)}`,
    `B: ${b.name}`,
    `   reviewer ${describeReviewer(b.run)}`,
    "",
    `Compared on ${countLabel(shared.length, "shared code version")}.${leftOut.length > 0 ? ` Left out: ${leftOut.join("; ")}.` : ""}`,
  ]
  const gaps = [...gapSentences("A", scoredA), ...gapSentences("B", scoredB)]
  if (gaps.length > 0) {
    lines.push(
      `Incomplete: ${gaps.join(" ")} Missing reviews can tilt every number below, so treat any difference as tentative.`,
    )
  }
  if (a.run.reviewer.protocol === undefined || b.run.reviewer.protocol === undefined) {
    lines.push(
      "At least one run used older rules that allowed access to the target pull request and repository history; its numbers are not comparable.",
    )
  }
  lines.push(
    "",
    "A:",
    ...scorecardLines(scoredA.score.scorecard).map((line) => `  ${line}`),
    "B:",
    ...scorecardLines(scoredB.score.scorecard).map((line) => `  ${line}`),
  )

  const scoresA = new Map(scoredA.score.cases.map((item) => [item.caseId, item]))
  const scoresB = new Map(scoredB.score.cases.map((item) => [item.caseId, item]))
  const versions = shared.map((evalCase) => ({
    evalCase,
    a: scoresA.get(evalCase.id),
    b: scoresB.get(evalCase.id),
  }))

  const metrics: Array<{
    title: string
    include: (score: CaseScore) => boolean
    count: (score: CaseScore) => number
    higherIsBetter: boolean
  }> = [
    {
      title: "Bad PRs blocked",
      include: (score) => score.kind === "blocking",
      count: (score) => score.blockedForRecordedBug,
      higherIsBetter: true,
    },
    {
      title: "OK PRs wrongly blocked",
      include: (score) => score.kind !== "blocking",
      count: (score) => score.wronglyBlocked,
      higherIsBetter: false,
    },
    {
      title: "Clean PRs left alone",
      include: (score) => score.kind === "control",
      count: (score) => score.quiet,
      higherIsBetter: true,
    },
  ]

  for (const metric of metrics) {
    lines.push("", `${metric.title}:`, ...metricComparison(versions, metric).map((line) => `  ${line}`))
  }
  const cardA = scoredA.score.scorecard
  const cardB = scoredB.score.scorecard
  lines.push(
    "",
    `Right call on every version and repeat: A ${rightEveryTime(scoredA.score)}, B ${rightEveryTime(scoredB.score)} of ${shared.length} versions.`,
    `Recorded advisory issues found: A ${fraction(cardA.advisoryIssues.found, cardA.advisoryIssues.chances)}, B ${fraction(cardB.advisoryIssues.found, cardB.advisoryIssues.chances)}. The recorded list is incomplete, so read this as a relative signal only.`,
  )
  return lines.join("\n")
}

/**
 * Same code, same pull-request context, and same recorded issues: everything
 * the review and the matching see. Only then is a score difference down to the
 * reviewer. Pack bookkeeping such as the version name may differ.
 */
function sameVersion(a: EvalCase, b: EvalCase): boolean {
  return versionKey(a) === versionKey(b)
}

function versionKey(evalCase: EvalCase): string {
  const { repositoryFullName, pullNumber, baseSha, headSha, context, changedLines, expected } = evalCase
  return JSON.stringify({
    repositoryFullName,
    pullNumber,
    baseSha,
    headSha,
    context,
    changedLines: Object.entries(changedLines).sort(([left], [right]) => left.localeCompare(right)),
    issues: [...expected.issues].sort((left, right) => left.id.localeCompare(right.id)),
  })
}

type ScoredRun = { score: EvalScore; excluded: number }

/** Scores only the shared versions, after dropping reviews that broke the rules. */
function scoreShared(run: EvalRun, ids: Set<string>): ScoredRun {
  const { run: checked, excluded } = excludeRuleBreakingReviews({
    ...run,
    cases: run.cases.filter((evalCase) => ids.has(evalCase.id)),
    samples: run.samples.filter((sample) => ids.has(sample.caseId)),
  })
  return { score: scoreRun(checked), excluded }
}

function gapSentences(name: string, { score, excluded }: ScoredRun): string[] {
  const unfinished = score.reviews - score.completedReviews - excluded
  const parts = [
    excluded > 0 ? `${excluded} broke the review rules` : "",
    unfinished > 0 ? `${unfinished} did not finish` : "",
    score.uncheckedIssues > 0
      ? `${countLabel(score.uncheckedIssues, "recorded issue")} ${score.uncheckedIssues === 1 ? "was" : "were"} not checked against the findings`
      : "",
  ].filter((part) => part !== "")
  if (parts.length === 0) return []
  return [`${name}: ${score.completedReviews} of ${score.reviews} reviews count (${parts.join("; ")}).`]
}

function metricComparison(
  versions: Array<{ evalCase: EvalCase; a: CaseScore | undefined; b: CaseScore | undefined }>,
  metric: {
    include: (score: CaseScore) => boolean
    count: (score: CaseScore) => number
    higherIsBetter: boolean
  },
): string[] {
  const rows = versions.flatMap(({ evalCase, a, b }) => {
    if (!a || !b || !metric.include(a) || a.completed === 0 || b.completed === 0) return []
    const rateA = metric.count(a) / a.completed
    const rateB = metric.count(b) / b.completed
    const direction = metric.higherIsBetter ? rateB - rateA : rateA - rateB
    return [{ evalCase, a, b, direction }]
  })
  if (rows.length === 0) return ["no versions to compare"]

  const bBetter = rows.filter((row) => row.direction > 0)
  const aBetter = rows.filter((row) => row.direction < 0)
  const tied = rows.length - bBetter.length - aBetter.length
  const totalA = rows.reduce((sum, row) => sum + metric.count(row.a), 0)
  const totalB = rows.reduce((sum, row) => sum + metric.count(row.b), 0)
  const reviewsA = rows.reduce((sum, row) => sum + row.a.completed, 0)
  const reviewsB = rows.reduce((sum, row) => sum + row.b.completed, 0)

  const lines = [
    `A ${fraction(totalA, reviewsA)}, B ${fraction(totalB, reviewsB)}.`,
    `B better on ${countLabel(bBetter.length, "version")}, A better on ${aBetter.length}, same on ${tied}. ${chanceSentence(bBetter.length, aBetter.length)}`,
  ]
  const describe = (row: (typeof rows)[number]) =>
    `#${row.evalCase.pullNumber} ${versionLabel(row.evalCase).toLowerCase()}: A ${metric.count(row.a)} of ${row.a.completed} → B ${metric.count(row.b)} of ${row.b.completed}`
  if (bBetter.length > 0) lines.push("B better:", ...bBetter.map((row) => `  ${describe(row)}`))
  if (aBetter.length > 0) lines.push("A better:", ...aBetter.map((row) => `  ${describe(row)}`))
  return lines
}

/**
 * If the two reviewers were really the same, each version that differs would
 * be equally likely to favour either side. This is how often chance alone
 * gives a split at least this lopsided (a two-sided sign test).
 */
export function chanceSentence(bBetter: number, aBetter: number): string {
  const differing = bBetter + aBetter
  if (differing === 0) return "No difference to weigh."
  const extreme = Math.max(bBetter, aBetter)
  let tail = 0
  for (let k = extreme; k <= differing; k += 1) tail += binomial(differing, k)
  const probability = Math.min(1, 2 * tail / 2 ** differing)
  if (differing < 6) {
    return `Only ${countLabel(differing, "version")} ${differing === 1 ? "differs" : "differ"}: too few to tell from chance.`
  }
  const percent = probability < 0.01 ? "under 1%" : `about ${Math.round(probability * 100)}%`
  return probability <= 0.05
    ? `Chance alone gives a split at least this lopsided ${percent} of the time, so this looks like a real difference.`
    : `Chance alone gives a split at least this lopsided ${percent} of the time, so this could easily be noise.`
}

function binomial(n: number, k: number): number {
  let result = 1
  for (let i = 1; i <= k; i += 1) result = (result * (n - k + i)) / i
  return result
}

function rightEveryTime(score: EvalScore): number {
  return score.cases.filter(isRightEveryTime).length
}

function describeReviewer(run: EvalRun): string {
  return `${run.reviewer.gitCommit.slice(0, 7)}${run.reviewer.dirty ? " (dirty)" : ""}, Amp mode ${run.reviewer.mode}, model ${run.reviewer.model ?? "not pinned"}, pack ${run.corpusVersion}`
}
