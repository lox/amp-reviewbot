import type { EvalCase, EvalRun, EvalSample } from "./schema.js"
import { expectedKind } from "./schema.js"
import type { EvalScore } from "./score.js"
import { auditEvidenceBoundary, sourcePreparationFromPrompt } from "./evidence.js"

export function formatReport(run: EvalRun, score: EvalScore): string {
  const boundaryViolations = contaminationCount(run)
  const lines = [
    "Review evaluation: DIAGNOSTIC ONLY",
    `Recorded result: ${reportVerdict(score, boundaryViolations)}`,
    "Reviewer egress was not isolated at execution time, so these counts are not blind review-quality evidence.",
    "",
  ]
  const counts = countKinds(run.cases)
  const seedCounts = countSeedOutcomes(score)
  lines.push(
    `${countLabel(score.seeds.length, "pull-request seed")}: ${seedCounts.pass} pass, ${seedCounts.unstable} unstable, ${seedCounts.fail} fail.`,
    `${countLabel(counts.control, "version with no frozen issue")}, ${countLabel(counts.advisory, "version with advisory label")}, and ${countLabel(counts.blocking, "version with blocking label")}.`,
    `Each was reviewed ${run.requestedSamplesPerCase} ${run.requestedSamplesPerCase === 1 ? "time" : "times"}. ${completionSentence(run, score)}`,
    "A seed vote matches only when every version finds every frozen issue at the correct blocking threshold and raises no alert on a version with no frozen issues.",
  )
  if (boundaryViolations > 0) {
    lines.push(
      `${boundaryViolations} review ${boundaryViolations === 1 ? "sample crossed" : "samples crossed"} the declared source-evidence boundary; treat this run as contaminated.`,
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
      `Example ${exampleNumber} (pull request #${cases[0]!.pullNumber}): ${seed.outcome.toUpperCase()} (${seed.passedSamples}/${seed.samples} seed votes matched)`,
    )
    for (const evalCase of cases) {
      const caseScore = scores.get(evalCase.id)
      if (!caseScore) continue
      lines.push(`  ${caseResult(evalCase, caseScore, samples.get(evalCase.id) ?? [])}`)
    }
  }

  lines.push("", "Bottom line", `  ${bottomLine(run, score, boundaryViolations)}`, "")
  lines.push(
    `Evidence: ${run.cases.length} code versions and ${run.samples.length} review runs.`,
    "This result covers only these examples; it is not a general quality claim.",
  )
  return lines.join("\n")
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
    if (completed === 0) return `${role}, no frozen issues: no reviews completed`
    const cleanAlerts = rateCount(score.cleanAlertRate, completed)
    return `${role}, no frozen issues: ${completed - cleanAlerts} of ${completed} completed reviews raised no clean alert`
  }
  const opportunities = score.samples * score.knownIssues
  const found = rateCount(score.issueDetectionRate, opportunities)
  const rightResponse = rateCount(score.groundedConclusionAgreement, score.samples)
  const label = kind === "advisory" ? "advisory labels" : "blocking labels"
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
  return `${role}, ${label}: ${foundText}; frozen-label response matched in ${rightResponse} of ${score.samples}${otherFindingsText}`
}

function reportVerdict(score: EvalScore, boundaryViolations: number): string {
  if (boundaryViolations > 0) return "CONTAMINATED"
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

function bottomLine(run: EvalRun, score: EvalScore, boundaryViolations: number): string {
  if (boundaryViolations > 0) {
    return `This run is diagnostic only because reviewer egress was not execution-isolated. A saved or current trace audit also detected ${boundaryViolations} review ${boundaryViolations === 1 ? "sample crossing" : "sample crossings"} of the declared source-evidence boundary.`
  }
  const diagnosticPrefix =
    "This run is diagnostic only because reviewer egress was not execution-isolated."
  if (score.operationalCompletion < 1) {
    return `${diagnosticPrefix} Some reviews did not finish, so the recorded counts are also incomplete.`
  }
  if (score.judgeCoverage !== null && score.judgeCoverage < 1) {
    return `${diagnosticPrefix} Some findings could not be checked against the known issues, so the recorded counts are also incomplete.`
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
      `The reviewer raised ${cleanAlerts} ${cleanAlerts === 1 ? "alert" : "alerts"} on versions with no frozen issues; these require source checking before they can be called unsupported.`,
    )
  }
  if (unmatchedFindings > 0) {
    observations.push(
      `${unmatchedFindings} unmatched ${unmatchedFindings === 1 ? "finding needs" : "findings need"} source checking.`,
    )
  }
  if (bugsFound < bugReviews) {
    observations.push(
      `The reviewer did not match the frozen issue in ${bugReviews - bugsFound} of ${bugReviews} labeled-issue reviews.`,
    )
  } else if (rightResponses < bugVersionReviews) {
    observations.push(
      "The reviewer found every known issue, but did not always respond with the right urgency.",
    )
  }
  return observations.length > 0
    ? `${diagnosticPrefix} ${observations.join(" ")}`
    : `${diagnosticPrefix} Within that limitation, the reviewer handled every recorded example correctly.`
}

function contaminationCount(run: EvalRun): number {
  return run.samples.filter((sample) => {
    const saved = sample.evidenceBoundaryViolations ?? []
    const current =
      sample.trace === undefined || sample.prompt === undefined
        ? []
        : auditEvidenceBoundary(sample.trace, sourcePreparationFromPrompt(sample.prompt))
    return saved.length > 0 || current.length > 0
  }).length
}

function rateCount(rate: number | null, total: number): number {
  return rate === null ? 0 : Math.round(rate * total)
}
