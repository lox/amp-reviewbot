import type { EvalCase, EvalRun, EvalSample } from "./schema.js"
import type { EvalScore } from "./score.js"

export function formatReport(run: EvalRun, score: EvalScore): string {
  const lines = [`Review evaluation: ${reportVerdict(score)}`, ""]
  const counts = countKinds(run.cases)
  lines.push(
    `${countLabel(counts.control, "clean change")}, ${countLabel(counts.advisory, "smaller bug")}, and ${countLabel(counts.blocking, "serious bug")}.`,
    `Each was reviewed ${run.requestedSamplesPerCase} ${run.requestedSamplesPerCase === 1 ? "time" : "times"}. ${completionSentence(run, score)}`,
    "A right response reports a smaller bug without blocking, and blocks a serious bug.",
  )

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
  for (const cases of examples.values()) {
    exampleNumber += 1
    lines.push("", `Example ${exampleNumber} (pull request #${cases[0]!.pullNumber})`)
    for (const kind of ["control", "advisory", "blocking"] as const) {
      const evalCase = cases.find((item) => item.expected.kind === kind)
      if (!evalCase) continue
      const caseScore = scores.get(evalCase.id)
      if (!caseScore) continue
      lines.push(`  ${caseResult(kind, caseScore, samples.get(evalCase.id) ?? [])}`)
    }
  }

  lines.push("", "Bottom line", `  ${bottomLine(run, score)}`, "")
  lines.push(
    `Evidence: ${run.cases.length} code versions and ${run.samples.length} review runs.`,
    "This result covers only these examples; it is not a general quality claim.",
  )
  return lines.join("\n")
}

function countKinds(cases: EvalCase[]): Record<"control" | "advisory" | "blocking", number> {
  const counts = { control: 0, advisory: 0, blocking: 0 }
  for (const evalCase of cases) counts[evalCase.expected.kind] += 1
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
  kind: "control" | "advisory" | "blocking",
  score: EvalScore["cases"][number],
  samples: EvalSample[],
): string {
  const completed = rateCount(score.operationalCompletion, score.samples)
  if (kind === "control") {
    if (completed === 0) return "Clean change: no reviews completed"
    const falseAlarms = rateCount(score.cleanAlertRate, completed)
    return `Clean change: ${completed - falseAlarms} of ${completed} completed reviews had no false alarms`
  }
  const found = rateCount(score.issueDetectionRate, score.samples)
  const rightResponse = rateCount(score.groundedConclusionAgreement, score.samples)
  const label = kind === "advisory" ? "Smaller bug" : "Serious bug"
  const otherFindings = samples.reduce((total, sample) => {
    if (sample.status === "error") return total
    const knownBug = sample.judgement?.matchingFindingIndices.length ? 1 : 0
    return total + Math.max(0, sample.retainedResult.findings.length - knownBug)
  }, 0)
  const otherFindingsText =
    otherFindings === 0
      ? ""
      : `; ${otherFindings} other ${otherFindings === 1 ? "finding needs" : "findings need"} checking`
  return `${label}: found in ${found} of ${score.samples}; right response in ${rightResponse} of ${score.samples}${otherFindingsText}`
}

function reportVerdict(score: EvalScore): string {
  if (
    score.operationalCompletion < 1 ||
    (score.judgeCoverage !== null && score.judgeCoverage < 1)
  ) {
    return "INCOMPLETE"
  }
  let needsMoreRuns = false
  for (const caseScore of score.cases) {
    const correct = rateCount(caseScore.groundedConclusionAgreement, caseScore.samples)
    if (caseScore.samples === 3 && correct === 2) {
      needsMoreRuns = true
      continue
    }
    if (caseScore.samples === 5 && correct >= 4) continue
    if (correct === caseScore.samples) continue
    if (caseScore.samples !== 5 && correct > caseScore.samples / 2) {
      needsMoreRuns = true
      continue
    }
    return "NEEDS WORK"
  }
  return needsMoreRuns ? "MORE RUNS NEEDED" : "PASSED THESE EXAMPLES"
}

function bottomLine(run: EvalRun, score: EvalScore): string {
  if (score.operationalCompletion < 1) {
    return "Some reviews did not finish, so this run cannot give a complete answer."
  }
  if (score.judgeCoverage !== null && score.judgeCoverage < 1) {
    return "Some findings could not be checked against the known bugs, so this run cannot give a complete answer."
  }
  const cases = new Map(run.cases.map((evalCase) => [evalCase.id, evalCase]))
  const cleanScores = score.cases.filter(
    (caseScore) => cases.get(caseScore.caseId)?.expected.kind === "control",
  )
  const bugScores = score.cases.filter(
    (caseScore) => cases.get(caseScore.caseId)?.expected.kind !== "control",
  )
  const falseAlarms = cleanScores.reduce((total, caseScore) => {
    const completed = rateCount(caseScore.operationalCompletion, caseScore.samples)
    return total + rateCount(caseScore.cleanAlertRate, completed)
  }, 0)
  const bugReviews = bugScores.reduce((total, caseScore) => total + caseScore.samples, 0)
  const bugsFound = bugScores.reduce(
    (total, caseScore) => total + rateCount(caseScore.issueDetectionRate, caseScore.samples),
    0,
  )
  const rightResponses = bugScores.reduce(
    (total, caseScore) => total + rateCount(caseScore.groundedConclusionAgreement, caseScore.samples),
    0,
  )

  const observations: string[] = []
  if (falseAlarms > 0) {
    observations.push(
      `The reviewer raised ${falseAlarms} ${falseAlarms === 1 ? "false alarm" : "false alarms"} on clean code.`,
    )
  }
  if (bugsFound < bugReviews) {
    observations.push(
      `The reviewer missed the known bug in ${bugReviews - bugsFound} of ${bugReviews} bug reviews.`,
    )
  } else if (rightResponses < bugReviews) {
    observations.push(
      "The reviewer found every known bug, but did not always respond with the right urgency.",
    )
  }
  return observations.length > 0
    ? observations.join(" ")
    : "The reviewer handled every example correctly in these runs."
}

function rateCount(rate: number | null, total: number): number {
  return rate === null ? 0 : Math.round(rate * total)
}
