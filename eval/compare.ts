import type { EvalCase, EvalRun } from "./schema.js"
import {
  countLabel,
  excludeRuleBreakingReviews,
  fraction,
  scorecardLines,
  versionLabel,
} from "./report.js"
import { scoreRun, type CaseScore, type EvalScore } from "./score.js"

type NamedRun = { name: string; run: EvalRun }

/**
 * Puts two saved runs side by side. Each version is compared with itself, so
 * an easier or harder version cannot tilt the result, and versions present in
 * only one run are left out.
 */
export function formatComparison(a: NamedRun, b: NamedRun): string {
  const scoreA = scoreRun(excludeRuleBreakingReviews(a.run).run)
  const scoreB = scoreRun(excludeRuleBreakingReviews(b.run).run)
  const casesA = new Map(a.run.cases.map((evalCase) => [evalCase.id, evalCase]))
  const shared = b.run.cases.filter((evalCase) => casesA.has(evalCase.id))
  const onlyOne = a.run.cases.length + b.run.cases.length - 2 * shared.length
  const differentIssues = shared.filter(
    (evalCase) => casesA.get(evalCase.id)!.expected.issues.length !== evalCase.expected.issues.length,
  ).length

  const lines = [
    `A: ${a.name}`,
    `   reviewer ${describeReviewer(a.run)}`,
    `B: ${b.name}`,
    `   reviewer ${describeReviewer(b.run)}`,
    "",
    `Compared on ${countLabel(shared.length, "shared code version")}.${onlyOne > 0 ? ` ${countLabel(onlyOne, "version")} in only one run ${onlyOne === 1 ? "is" : "are"} left out.` : ""}${differentIssues > 0 ? ` ${countLabel(differentIssues, "version")} ${differentIssues === 1 ? "has" : "have"} a different recorded-issue count in the two runs; the runs used different example packs.` : ""}`,
    "",
    "A:",
    ...scorecardLines(scoreA.scorecard).map((line) => `  ${line}`),
    "B:",
    ...scorecardLines(scoreB.scorecard).map((line) => `  ${line}`),
  ]

  const sharedIds = new Set(shared.map((evalCase) => evalCase.id))
  const scoresA = new Map(scoreA.cases.map((item) => [item.caseId, item]))
  const scoresB = new Map(scoreB.cases.map((item) => [item.caseId, item]))
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
  lines.push(
    "",
    `Right call on every version and repeat: A ${rightEveryTime(scoreA, sharedIds)}, B ${rightEveryTime(scoreB, sharedIds)} of ${shared.length} versions.`,
    `Recorded advisory issues found: A ${fraction(scoreA.scorecard.advisoryIssues.found, scoreA.scorecard.advisoryIssues.chances)}, B ${fraction(scoreB.scorecard.advisoryIssues.found, scoreB.scorecard.advisoryIssues.chances)}. The recorded list is incomplete, so read this as a relative signal only.`,
  )
  return lines.join("\n")
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

function rightEveryTime(score: EvalScore, ids: Set<string>): number {
  return score.cases.filter(
    (item) => ids.has(item.caseId) && item.completed > 0 && item.rightCalls === item.completed,
  ).length
}

function describeReviewer(run: EvalRun): string {
  return `${run.reviewer.gitCommit.slice(0, 7)}${run.reviewer.dirty ? " (dirty)" : ""}, Amp mode ${run.reviewer.mode}, model ${run.reviewer.model ?? "not pinned"}, pack ${run.corpusVersion}`
}
