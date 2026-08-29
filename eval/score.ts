import { isBlockingSeverity } from "../src/review.js"
import type { EvalRun, EvalSample, ExpectedIssue } from "./schema.js"
import { expectedConclusion, expectedKind } from "./schema.js"

export type CaseScore = {
  caseId: string
  samples: number
  knownIssues: number
  operationalCompletion: number
  conclusionAgreement: number
  groundedConclusionAgreement: number
  cleanAlertRate: number | null
  issueDetectionRate: number | null
  findingPrecision: number | null
  severityAgreement: number | null
  severityThresholdAgreement: number | null
  judgeCoverage: number | null
  judgeDisagreementRate: number | null
  conclusions: Record<"success" | "neutral" | "failure" | "error", number>
}

export type EvalScore = {
  cases: CaseScore[]
  operationalCompletion: number
  conclusionAgreement: number
  groundedConclusionAgreement: number
  cleanAlertRate: number | null
  issueDetectionRate: number | null
  findingPrecision: number | null
  severityAgreement: number | null
  severityThresholdAgreement: number | null
  judgeCoverage: number | null
  judgeDisagreementRate: number | null
}

type CompletedSample = Extract<EvalSample, { status: "completed" }>

export function scoreRun(run: EvalRun): EvalScore {
  const byCase = new Map<string, EvalSample[]>()
  for (const sample of run.samples) {
    const samples = byCase.get(sample.caseId) ?? []
    samples.push(sample)
    byCase.set(sample.caseId, samples)
  }

  const cases = [...byCase.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([caseId, samples]) => scoreCase(caseId, samples))

  return {
    cases,
    operationalCompletion: mean(cases.map((item) => item.operationalCompletion))!,
    conclusionAgreement: mean(cases.map((item) => item.conclusionAgreement))!,
    groundedConclusionAgreement: mean(cases.map((item) => item.groundedConclusionAgreement))!,
    cleanAlertRate: mean(cases.map((item) => item.cleanAlertRate)),
    issueDetectionRate: mean(cases.map((item) => item.issueDetectionRate)),
    findingPrecision: mean(cases.map((item) => item.findingPrecision)),
    severityAgreement: mean(cases.map((item) => item.severityAgreement)),
    severityThresholdAgreement: mean(cases.map((item) => item.severityThresholdAgreement)),
    judgeCoverage: mean(cases.map((item) => item.judgeCoverage)),
    judgeDisagreementRate: mean(cases.map((item) => item.judgeDisagreementRate)),
  }
}

function scoreCase(caseId: string, samples: EvalSample[]): CaseScore {
  const expected = samples[0]!.expected
  const kind = expectedKind(expected)
  const completed = samples.filter((sample): sample is CompletedSample => sample.status === "completed")
  const assignments = new Map(completed.map((sample) => [sample.sample, assignFindings(sample)]))
  const detected = [...assignments.values()].reduce((total, assignment) => total + assignment.size, 0)
  const severityMatches = completed.reduce(
    (total, sample) => total + assignFindings(sample, matchedSeverity).size,
    0,
  )
  const thresholdMatches = completed.reduce(
    (total, sample) => total + assignFindings(sample, matchedThreshold).size,
    0,
  )
  const reportedFindings = completed.reduce(
    (total, sample) => total + sample.retainedResult.findings.length,
    0,
  )
  const eligibleJudgements = completed.reduce(
    (total, sample) =>
      total + (sample.retainedResult.findings.length > 0 ? expected.issues.length : 0),
    0,
  )
  const judgements = completed.flatMap((sample) => sample.judgements)
  const conclusions = { success: 0, neutral: 0, failure: 0, error: 0 }

  for (const sample of samples) {
    if (sample.status === "error") conclusions.error += 1
    else conclusions[sample.conclusion] += 1
  }

  return {
    caseId,
    samples: samples.length,
    knownIssues: expected.issues.length,
    operationalCompletion: completed.length / samples.length,
    conclusionAgreement:
      samples.filter(
        (sample) =>
          sample.status === "completed" && sample.conclusion === expectedConclusion(sample.expected),
      ).length / samples.length,
    groundedConclusionAgreement:
      samples.filter((sample) => isGroundedConclusion(sample)).length / samples.length,
    cleanAlertRate:
      kind === "control"
        ? completed.length === 0
          ? null
          : completed.filter((sample) => sample.retainedResult.findings.length > 0).length /
            completed.length
        : null,
    issueDetectionRate:
      kind === "control" ? null : detected / (expected.issues.length * samples.length),
    findingPrecision:
      kind === "control" || reportedFindings === 0 ? null : detected / reportedFindings,
    severityAgreement:
      kind === "control" || detected === 0 ? null : severityMatches / detected,
    severityThresholdAgreement:
      kind === "control" || detected === 0 ? null : thresholdMatches / detected,
    judgeCoverage:
      kind === "control" || eligibleJudgements === 0
        ? null
        : judgements.length / eligibleJudgements,
    judgeDisagreementRate:
      kind === "control" || judgements.length === 0
        ? null
        : judgements.filter((judgement) => judgement.disagreement).length / judgements.length,
    conclusions,
  }
}

function isGroundedConclusion(sample: EvalSample): boolean {
  if (sample.status === "error") return false
  const kind = expectedKind(sample.expected)
  if (kind === "control") {
    return sample.conclusion === "success" && sample.retainedResult.findings.length === 0
  }
  const assignment = assignFindings(sample, matchedThreshold)
  return (
    sample.conclusion === expectedConclusion(sample.expected) &&
    assignment.size === sample.expected.issues.length
  )
}

function assignFindings(
  sample: CompletedSample,
  accepts: (issue: ExpectedIssue, sample: CompletedSample, findingIndex: number) => boolean = () =>
    true,
): Map<string, number> {
  const judgements = new Map(
    sample.judgements.map((judgement) => [judgement.issueId, judgement.matchingFindingIndices]),
  )
  const choices = new Map(
    sample.expected.issues.map((issue) => [
      issue.id,
      (judgements.get(issue.id) ?? []).filter((finding) => accepts(issue, sample, finding)),
    ]),
  )
  const findingToIssue = new Map<number, string>()

  for (const issue of sample.expected.issues) {
    assign(issue.id, new Set())
  }
  return new Map([...findingToIssue].map(([finding, issue]) => [issue, finding]))

  function assign(issueId: string, visited: Set<number>): boolean {
    for (const finding of choices.get(issueId) ?? []) {
      if (visited.has(finding)) continue
      visited.add(finding)
      const currentIssue = findingToIssue.get(finding)
      if (!currentIssue || assign(currentIssue, visited)) {
        findingToIssue.set(finding, issueId)
        return true
      }
    }
    return false
  }
}

function matchedSeverity(
  issue: ExpectedIssue,
  sample: CompletedSample,
  findingIndex: number,
): boolean {
  return sample.retainedResult.findings[findingIndex]?.severity === issue.severity
}

function matchedThreshold(
  issue: ExpectedIssue,
  sample: CompletedSample,
  findingIndex: number,
): boolean {
  const finding = sample.retainedResult.findings[findingIndex]
  return (
    finding !== undefined &&
    isBlockingSeverity(finding.severity, "high") === isBlockingSeverity(issue.severity, "high")
  )
}

function mean(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null)
  if (present.length === 0) return null
  return present.reduce((total, value) => total + value, 0) / present.length
}
