import type { EvalCase, EvalRun, EvalSample } from "./schema.js"
import { expectedKind } from "./schema.js"
import { scoreRun, type EvalScore } from "./score.js"
import { checkReviewTrace, sourcePreparationFromPrompt } from "./evidence.js"

export function formatReport(savedRun: EvalRun): string {
  // A review that broke the rules is excluded from the counts like a review
  // that never finished; the other reviews in the run remain comparable.
  const { run, excluded: traceProblems } = excludeRuleBreakingReviews(savedRun)
  const score = scoreRun(run)
  const usesCurrentRules = run.reviewer.protocol?.startsWith("research-enabled-target-frozen") ?? false
  const lines = usesCurrentRules
    ? [
        "Review evaluation: PUBLIC RESEARCH ALLOWED",
        `Recorded result: ${reportVerdict(score)}`,
        "The reviewer could research anything public except this pull request and another copy or later version of the target repository.",
        `Reviewer: Amp mode ${run.reviewer.mode}. Model: ${run.reviewer.model ?? "not pinned"}. SDK: ${run.reviewer.sdkVersion}. CLI: ${run.reviewer.cliVersion ?? "not recorded"}.`,
        modelSentence(savedRun),
        "",
      ]
    : [
        "Review evaluation: HISTORICAL RESULT",
        `Recorded result: ${reportVerdict(score)}`,
        "This older run allowed access to the target pull request and repository history. Use its counts for investigation, not comparison.",
        "",
      ]
  const counts = countKinds(run.cases)
  const seedCounts = countSeedOutcomes(score)
  lines.push(
    `${countLabel(score.seeds.length, "pull-request example")}: ${seedCounts.pass} pass, ${seedCounts.unstable} unstable, ${seedCounts.fail} fail.`,
    `${versionCount(counts.control, "with no recorded issues")}, ${versionCount(counts.advisory, "with recorded non-blocking issues")}, and ${versionCount(counts.blocking, "with recorded blocking issues")}.`,
    `Each was reviewed ${run.requestedSamplesPerCase} ${run.requestedSamplesPerCase === 1 ? "time" : "times"}. ${completionSentence(run, score)}`,
    "One repeat passes only when every version finds every recorded issue with the right urgency and raises no alert on a version with no recorded issues.",
  )
  if (traceProblems > 0) {
    lines.push(
      `${traceProblems} review ${traceProblems === 1 ? "did" : "runs did"} not follow the review rules and ${traceProblems === 1 ? "is" : "are"} excluded from these counts.`,
    )
  }
  lines.push(...resourceLines(savedRun))

  const scores = new Map(score.cases.map((caseScore) => [caseScore.caseId, caseScore]))
  const samples = new Map<string, EvalSample[]>()
  for (const sample of run.samples) {
    const caseSamples = samples.get(sample.caseId) ?? []
    caseSamples.push(sample)
    samples.set(sample.caseId, caseSamples)
  }
  const examples = new Map<string, EvalCase[]>()
  for (const evalCase of run.cases) {
    const cases = examples.get(evalCase.seedId) ?? []
    cases.push(evalCase)
    examples.set(evalCase.seedId, cases)
  }

  let exampleNumber = 0
  const seedScores = new Map(score.seeds.map((seed) => [seed.seedId, seed]))
  for (const cases of examples.values()) {
    exampleNumber += 1
    const seed = seedScores.get(cases[0]!.seedId)!
    lines.push(
      "",
      `Example ${exampleNumber} (pull request #${cases[0]!.pullNumber}): ${seed.outcome.toUpperCase()} (${seed.passedSamples}/${seed.samples} repeats passed)`,
    )
    for (const evalCase of cases) {
      const caseScore = scores.get(evalCase.id)
      if (!caseScore) continue
      lines.push(`  ${caseResult(evalCase, caseScore, samples.get(evalCase.id) ?? [])}`)
    }
  }

  lines.push(
    "",
    "Bottom line",
    `  ${bottomLine(run, score, traceProblems, usesCurrentRules)}`,
    "",
  )
  lines.push(
    `Evidence: ${run.cases.length} code versions and ${run.samples.length} review runs.`,
    "This result covers only these examples; it is not a general quality claim.",
  )
  return lines.join("\n")
}

function modelSentence(run: EvalRun): string {
  const models = new Set<string>()
  for (const sample of run.samples) {
    for (const model of sample.models) models.add(model)
    if (sample.status === "completed") {
      for (const judgement of sample.judgements) {
        for (const model of judgement.models) models.add(model)
      }
    }
  }
  return models.size === 0
    ? "Exact model IDs: not reported by Amp."
    : `Reported model IDs: ${[...models].sort().join(", ")}.`
}

export interface ReviewResources {
  reviews: number
  totalReviewMs: number
  medianReviewMs: number
  longestReviewMs: number
  /** What Amp billed, from `amp threads usage`; absent when no review recorded it. */
  billed?: {
    reviews: number
    costUsd: number
    medianCostUsd: number
    inputTokens: number
    outputTokens: number
    requests: number
    subscriptionUsed: boolean
  }
  /** Tokens summed from the assistant turns in the saved traces (no subagent turns, no cost). */
  traced?: {
    reviews: number
    inputTokens: number
    outputTokens: number
    medianInputTokens: number
  }
}

/**
 * Time, cost, and tokens spent by the reviewer across every saved review,
 * including reviews later excluded from the counts, which still cost money.
 */
export function reviewResources(run: EvalRun): ReviewResources | undefined {
  const durations = run.samples.flatMap((sample) => sample.reviewDurationMs ?? [])
  if (durations.length === 0) return undefined
  const usages = run.samples.flatMap((sample) => sample.usage ?? [])
  // An empty trace means Amp never started, so there is no usage to count.
  const traced = run.samples.flatMap((sample) =>
    sample.trace === undefined || sample.trace.length === 0 ? [] : [sumTraceUsage(sample.trace)],
  )
  return {
    reviews: durations.length,
    totalReviewMs: durations.reduce((sum, ms) => sum + ms, 0),
    medianReviewMs: median(durations),
    longestReviewMs: Math.max(...durations),
    ...(usages.length === 0
      ? {}
      : {
          billed: {
            reviews: usages.length,
            costUsd: usages.reduce((sum, usage) => sum + usage.costUsd, 0),
            medianCostUsd: median(usages.map((usage) => usage.costUsd)),
            inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
            outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
            requests: usages.reduce((sum, usage) => sum + usage.requests, 0),
            subscriptionUsed: usages.some((usage) => usage.subscriptionUsed),
          },
        }),
    ...(traced.length === 0
      ? {}
      : {
          traced: {
            reviews: traced.length,
            inputTokens: traced.reduce((sum, usage) => sum + usage.input, 0),
            outputTokens: traced.reduce((sum, usage) => sum + usage.output, 0),
            medianInputTokens: median(traced.map((usage) => usage.input)),
          },
        }),
  }
}

function resourceLines(run: EvalRun): string[] {
  const resources = reviewResources(run)
  if (resources === undefined) return []
  const lines = [
    `Review time: ${countLabel(resources.reviews, "review")} took ${hours(resources.totalReviewMs)} in total; median ${minutes(resources.medianReviewMs)}, longest ${minutes(resources.longestReviewMs)}.`,
  ]
  const { billed, traced } = resources
  if (billed !== undefined) {
    const coverage = billed.reviews === resources.reviews ? "" : ` (${billed.reviews} of ${resources.reviews} reviews reported usage)`
    lines.push(
      `Amp usage${coverage}: $${billed.costUsd.toFixed(2)} in credits, ${millions(billed.inputTokens)} input tokens, ${millions(billed.outputTokens)} output tokens, ${countLabel(billed.requests, "model request")}; median $${billed.medianCostUsd.toFixed(2)} per review. Subagent threads are included.${billed.subscriptionUsed ? " A subscription covered some inference, so credits understate the cost." : ""}`,
    )
  } else if (traced !== undefined) {
    lines.push(
      `Reviewer tokens from ${countLabel(traced.reviews, "trace")}: ${millions(traced.inputTokens)} input tokens (including cache reads and writes), ${millions(traced.outputTokens)} output tokens; median ${millions(traced.medianInputTokens)} input tokens per review. This run recorded no Amp usage, so cost is unknown and tokens spent by delegated subagents are not counted.`,
    )
  }
  return lines
}

function sumTraceUsage(trace: unknown[]): { input: number; output: number } {
  const usage = { input: 0, output: 0 }
  for (const message of trace) {
    if (!message || typeof message !== "object" || !("message" in message)) continue
    const body = message.message
    if (!body || typeof body !== "object" || !("usage" in body)) continue
    const counts = body.usage
    if (!counts || typeof counts !== "object") continue
    usage.input +=
      tokenCount(counts, "input_tokens") +
      tokenCount(counts, "cache_creation_input_tokens") +
      tokenCount(counts, "cache_read_input_tokens")
    usage.output += tokenCount(counts, "output_tokens")
  }
  return usage
}

function tokenCount(usage: object, key: string): number {
  const value = (usage as Record<string, unknown>)[key]
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function minutes(ms: number): string {
  return `${(ms / 60_000).toFixed(1)} min`
}

function hours(ms: number): string {
  return ms < 3_600_000 ? minutes(ms) : `${(ms / 3_600_000).toFixed(1)} hours`
}

function millions(tokens: number): string {
  return tokens < 1_000_000 ? `${Math.round(tokens / 1_000)}k` : `${(tokens / 1_000_000).toFixed(1)}M`
}

function countSeedOutcomes(score: EvalScore): Record<"pass" | "unstable" | "fail", number> {
  const counts = { pass: 0, unstable: 0, fail: 0 }
  for (const seed of score.seeds) counts[seed.outcome] += 1
  return counts
}

function countKinds(cases: EvalCase[]): Record<"control" | "advisory" | "blocking", number> {
  const counts = { control: 0, advisory: 0, blocking: 0 }
  for (const evalCase of cases) counts[expectedKind(evalCase.expected)] += 1
  return counts
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`
}

function versionCount(count: number, description: string): string {
  return `${count} ${count === 1 ? "version" : "versions"} ${description}`
}

function completionSentence(run: EvalRun, score: EvalScore): string {
  const completed = rateCount(score.operationalCompletion, run.samples.length)
  return completed === run.samples.length
    ? `All ${run.samples.length} reviews completed.`
    : `${completed} of ${run.samples.length} reviews completed.`
}

function caseResult(
  evalCase: EvalCase,
  score: EvalScore["cases"][number],
  samples: EvalSample[],
): string {
  const kind = expectedKind(evalCase.expected)
  const role =
    evalCase.versionRole === "baseline"
      ? "Baseline"
      : evalCase.versionRole === "introduced-issue"
        ? "Introduced-issue version"
        : "Version"
  const completed = rateCount(score.operationalCompletion, score.samples)
  if (kind === "control") {
    if (completed === 0) return `${role}, no recorded issues: no reviews completed`
    const cleanAlerts = rateCount(score.cleanAlertRate, completed)
    return `${role}, no recorded issues: ${completed - cleanAlerts} of ${completed} completed reviews raised no alert${droppedFindingsText(droppedFindings(samples))}`
  }
  const opportunities = score.samples * score.knownIssues
  const found = rateCount(score.issueDetectionRate, opportunities)
  const rightResponse = rateCount(score.groundedConclusionAgreement, score.samples)
  const label =
    kind === "advisory" ? "recorded non-blocking issues" : "recorded blocking issues"
  const retainedFindings = samples.reduce(
    (total, sample) =>
      total + (sample.status === "completed" ? sample.retainedResult.findings.length : 0),
    0,
  )
  const otherFindings = Math.max(0, retainedFindings - found)
  const otherFindingsText =
    otherFindings === 0
      ? ""
      : `; ${otherFindings} unmatched ${otherFindings === 1 ? "finding needs" : "findings need"} source checking`
  const foundText =
    score.knownIssues === 1
      ? `found in ${found} of ${score.samples}`
      : `${found} of ${opportunities} known issues found`
  return `${role}, ${label}: ${foundText}; response matched the recorded issues in ${rightResponse} of ${score.samples}${otherFindingsText}${droppedFindingsText(droppedFindings(samples))}`
}

function droppedFindings(samples: EvalSample[]): number {
  return samples.reduce(
    (total, sample) => total + (sample.status === "completed" ? sample.omitted : 0),
    0,
  )
}

function droppedFindingsText(dropped: number): string {
  if (dropped === 0) return ""
  return `; ${dropped} raw ${dropped === 1 ? "finding" : "findings"} dropped for not pointing at a changed line`
}

function reportVerdict(score: EvalScore): string {
  if (score.seeds.length === 0) return "INCOMPLETE"
  if (
    score.operationalCompletion < 1 ||
    (score.judgeCoverage !== null && score.judgeCoverage < 1)
  ) {
    return "INCOMPLETE"
  }
  if (score.seeds.some((seed) => seed.outcome === "fail")) return "NEEDS WORK"
  if (score.seeds.some((seed) => seed.outcome === "unstable")) return "UNSTABLE"
  return "PASSED THESE EXAMPLES"
}

function bottomLine(
  run: EvalRun,
  score: EvalScore,
  traceProblems: number,
  usesCurrentRules: boolean,
): string {
  const scopePrefix = usesCurrentRules
    ? "Under these review rules,"
    : "For investigation only;"
  if (!usesCurrentRules && traceProblems > 0) {
    return `This historical run is for investigation only. Its trace also shows that ${traceProblems} review ${traceProblems === 1 ? "did" : "runs did"} not follow the current rules.`
  }
  if (traceProblems > 0) {
    return `${scopePrefix} ${traceProblems} review ${traceProblems === 1 ? "did" : "runs did"} not follow the source setup or target repository rules and ${traceProblems === 1 ? "was" : "were"} excluded, so the recorded counts are incomplete.`
  }
  if (score.operationalCompletion < 1) {
    return `${scopePrefix} some reviews did not finish, so the recorded counts are incomplete.`
  }
  if (score.judgeCoverage !== null && score.judgeCoverage < 1) {
    return `${scopePrefix} some findings could not be checked against the known issues, so the recorded counts are incomplete.`
  }
  const cases = new Map(run.cases.map((evalCase) => [evalCase.id, evalCase]))
  const cleanScores = score.cases.filter(
    (caseScore) => expectedKind(cases.get(caseScore.caseId)!.expected) === "control",
  )
  const bugScores = score.cases.filter(
    (caseScore) => expectedKind(cases.get(caseScore.caseId)!.expected) !== "control",
  )
  const cleanAlerts = cleanScores.reduce((total, caseScore) => {
    const completed = rateCount(caseScore.operationalCompletion, caseScore.samples)
    return total + rateCount(caseScore.cleanAlertRate, completed)
  }, 0)
  const issueChances = bugScores.reduce(
    (total, caseScore) => total + caseScore.samples * caseScore.knownIssues,
    0,
  )
  const bugVersionReviews = bugScores.reduce((total, caseScore) => total + caseScore.samples, 0)
  const bugsFound = bugScores.reduce(
    (total, caseScore) =>
      total + rateCount(caseScore.issueDetectionRate, caseScore.samples * caseScore.knownIssues),
    0,
  )
  const rightResponses = bugScores.reduce(
    (total, caseScore) => total + rateCount(caseScore.groundedConclusionAgreement, caseScore.samples),
    0,
  )
  const retainedFindings = run.samples.reduce(
    (total, sample) =>
      total + (sample.status === "completed" ? sample.retainedResult.findings.length : 0),
    0,
  )
  const unmatchedFindings = Math.max(0, retainedFindings - bugsFound)
  const dropped = droppedFindings(run.samples)

  const observations: string[] = []
  if (cleanAlerts > 0) {
    observations.push(
      `the reviewer raised ${cleanAlerts} ${cleanAlerts === 1 ? "alert" : "alerts"} on versions with no recorded issues; check the source before deciding whether those alerts were wrong.`,
    )
  }
  if (unmatchedFindings > 0) {
    observations.push(
      `${unmatchedFindings} unmatched ${unmatchedFindings === 1 ? "finding needs" : "findings need"} source checking.`,
    )
  }
  if (bugsFound < issueChances) {
    observations.push(
      `the reviewer missed ${issueChances - bugsFound} of ${issueChances} chances to find a recorded issue across ${bugVersionReviews} ${bugVersionReviews === 1 ? "review" : "reviews"} of versions with issues.`,
    )
    if (dropped > 0) {
      observations.push(
        `${dropped} raw ${dropped === 1 ? "finding was" : "findings were"} dropped for not pointing at a changed line; check whether ${dropped === 1 ? "it describes" : "they describe"} the missed issues before treating this as a reviewer miss.`,
      )
    }
  } else if (rightResponses < bugVersionReviews) {
    observations.push(
      "the reviewer found every known issue, but did not always respond with the right urgency.",
    )
  }
  return observations.length > 0
    ? `${scopePrefix} ${observations.join(" ")}`
    : `${scopePrefix} the reviewer handled every recorded example correctly.`
}

function excludeRuleBreakingReviews(run: EvalRun): { run: EvalRun; excluded: number } {
  const cases = new Map(run.cases.map((evalCase) => [evalCase.id, evalCase]))
  let excluded = 0
  const samples = run.samples.map((sample): EvalSample => {
    const evalCase = cases.get(sample.caseId)!
    // The stored trace is the evidence; the saved violation list is only a cache
    // of an earlier check and is used when the trace was not kept.
    const problems =
      sample.trace === undefined || sample.prompt === undefined
        ? (sample.evidenceBoundaryViolations ?? [])
        : checkReviewTrace(
            sample.trace,
            sourcePreparationFromPrompt(sample.sourceSetupPrompt ?? sample.prompt),
            {
              repository: evalCase.repositoryFullName,
              pullNumber: evalCase.pullNumber,
              baseSha: evalCase.baseSha,
              headSha: evalCase.headSha,
            },
            run.reviewer.protocol?.startsWith("research-enabled-target-frozen")
              ? run.reviewer.mode
              : undefined,
            run.reviewer.protocol === "research-enabled-target-frozen-v4"
              ? "separate-turn"
              : run.reviewer.protocol === "research-enabled-target-frozen-v5"
                ? "plugin"
                : undefined,
          )
    if (problems.length === 0) return sample
    excluded += 1
    if (sample.status === "error") return sample
    const {
      rawResult: _rawResult,
      parsedResult: _parsedResult,
      retainedResult: _retainedResult,
      omitted: _omitted,
      conclusion: _conclusion,
      judgements: _judgements,
      judgementErrors: _judgementErrors,
      ...common
    } = sample
    return {
      ...common,
      status: "error",
      error: `did not follow the review rules: ${problems.join("; ")}`,
    }
  })
  return { run: { ...run, samples }, excluded }
}

function rateCount(rate: number | null, total: number): number {
  return rate === null ? 0 : Math.round(rate * total)
}
