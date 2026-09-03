import type { EvalCase, EvalRun, EvalSample } from "./schema.js"
import { expectedKind } from "./schema.js"
import type { EvalScore } from "./score.js"
import { checkReviewTrace, sourcePreparationFromPrompt } from "./evidence.js"

export function formatReport(run: EvalRun, score: EvalScore): string {
  const traceProblems = traceProblemCount(run)
  const usesCurrentRules = run.reviewer.protocol?.startsWith("research-enabled-target-frozen") ?? false
  const lines = usesCurrentRules
    ? [
        "Review evaluation: PUBLIC RESEARCH ALLOWED",
        `Recorded result: ${reportVerdict(score, traceProblems)}`,
        "The reviewer could research anything public except this pull request and another copy or later version of the target repository.",
        `Reviewer: Amp mode ${run.reviewer.mode}. Model: ${run.reviewer.model ?? "not pinned"}. SDK: ${run.reviewer.sdkVersion}. CLI: ${run.reviewer.cliVersion ?? "not recorded"}.`,
        modelSentence(run),
        "",
      ]
    : [
        "Review evaluation: HISTORICAL RESULT",
        `Recorded result: ${reportVerdict(score, traceProblems)}`,
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
      `${traceProblems} review ${traceProblems === 1 ? "did" : "runs did"} not follow the review rules. This run is not valid for comparison.`,
    )
  }

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
    return `${role}, no recorded issues: ${completed - cleanAlerts} of ${completed} completed reviews raised no alert`
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
  return `${role}, ${label}: ${foundText}; response matched the recorded issues in ${rightResponse} of ${score.samples}${otherFindingsText}`
}

function reportVerdict(score: EvalScore, traceProblems: number): string {
  if (traceProblems > 0) return "INVALID FOR COMPARISON"
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
  if (traceProblems > 0) {
    return usesCurrentRules
      ? `${traceProblems} review ${traceProblems === 1 ? "did" : "runs did"} not follow the source setup or target repository rules, so this run cannot be compared with other runs.`
      : `This historical run is for investigation only. Its trace also shows that ${traceProblems} review ${traceProblems === 1 ? "did" : "runs did"} not follow the current rules.`
  }
  const scopePrefix = usesCurrentRules
    ? "Under these review rules,"
    : "For investigation only;"
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
  const bugReviews = bugScores.reduce(
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

  const observations: string[] = []
  if (cleanAlerts > 0) {
    observations.push(
      `The reviewer raised ${cleanAlerts} ${cleanAlerts === 1 ? "alert" : "alerts"} on versions with no recorded issues; check the source before deciding whether those alerts were wrong.`,
    )
  }
  if (unmatchedFindings > 0) {
    observations.push(
      `${unmatchedFindings} unmatched ${unmatchedFindings === 1 ? "finding needs" : "findings need"} source checking.`,
    )
  }
  if (bugsFound < bugReviews) {
    observations.push(
      `The reviewer missed a recorded issue in ${bugReviews - bugsFound} of ${bugReviews} reviews of versions with issues.`,
    )
  } else if (rightResponses < bugVersionReviews) {
    observations.push(
      "The reviewer found every known issue, but did not always respond with the right urgency.",
    )
  }
  return observations.length > 0
    ? `${scopePrefix} ${observations.join(" ")}`
    : `${scopePrefix} the reviewer handled every recorded example correctly.`
}

function traceProblemCount(run: EvalRun): number {
  const cases = new Map(run.cases.map((evalCase) => [evalCase.id, evalCase]))
  return run.samples.filter((sample) => {
    const saved = sample.evidenceBoundaryViolations ?? []
    const evalCase = cases.get(sample.caseId)!
    const current =
      sample.trace === undefined || sample.prompt === undefined
        ? []
        : checkReviewTrace(
            sample.trace,
            sourcePreparationFromPrompt(sample.prompt),
            {
              repository: evalCase.repositoryFullName,
              pullNumber: evalCase.pullNumber,
              baseSha: evalCase.baseSha,
              headSha: evalCase.headSha,
            },
            run.reviewer.protocol?.startsWith("research-enabled-target-frozen")
              ? run.reviewer.mode
              : undefined,
          )
    return saved.length > 0 || current.length > 0
  }).length
}

function rateCount(rate: number | null, total: number): number {
  return rate === null ? 0 : Math.round(rate * total)
}
