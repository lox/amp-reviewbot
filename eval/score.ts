import { isBlockingSeverity } from "../src/review.js"
import type { EvalRun, EvalSample } from "./schema.js"
import { expectedConclusion } from "./schema.js"

export type CaseScore = {
  caseId: string
  samples: number
  operationalCompletion: number
  conclusionAgreement: number
  groundedConclusionAgreement: number
  cleanAlertRate: number | null
  issueDetectionRate: number | null
  injectionPrecision: number | null
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
  injectionPrecision: number | null
  severityAgreement: number | null
  severityThresholdAgreement: number | null
  judgeCoverage: number | null
  judgeDisagreementRate: number | null
}

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
    injectionPrecision: mean(cases.map((item) => item.injectionPrecision)),
    severityAgreement: mean(cases.map((item) => item.severityAgreement)),
    severityThresholdAgreement: mean(cases.map((item) => item.severityThresholdAgreement)),
    judgeCoverage: mean(cases.map((item) => item.judgeCoverage)),
    judgeDisagreementRate: mean(cases.map((item) => item.judgeDisagreementRate)),
  }
}

function scoreCase(caseId: string, samples: EvalSample[]): CaseScore {
  const expected = samples[0]!.expected
  const completed = samples.filter((sample) => sample.status === "completed")
  const judgeEligible = completed.filter((sample) => sample.retainedResult.findings.length > 0)
  const judged = completed.filter((sample) => sample.judgement !== null)
  const detections = judged.filter(
    (sample) => sample.judgement!.matchingFindingIndices.length > 0,
  )
  const conclusions = { success: 0, neutral: 0, failure: 0, error: 0 }

  for (const sample of samples) {
    if (sample.status === "error") conclusions.error += 1
    else conclusions[sample.conclusion] += 1
  }

  const conclusionAgreement =
    samples.filter(
      (sample) =>
        sample.status === "completed" && sample.conclusion === expectedConclusion(sample.expected),
    ).length / samples.length
  const groundedConclusionAgreement =
    samples.filter((sample) => isGroundedConclusion(sample)).length / samples.length

  return {
    caseId,
    samples: samples.length,
    operationalCompletion: completed.length / samples.length,
    conclusionAgreement,
    groundedConclusionAgreement,
    cleanAlertRate:
      expected.kind === "control"
        ? completed.length === 0
          ? null
          : completed.filter((sample) => sample.retainedResult.findings.length > 0).length /
            completed.length
        : null,
    issueDetectionRate:
      expected.kind === "control" ? null : detections.length / samples.length,
    injectionPrecision:
      expected.kind === "control"
        ? null
        : mean(
            judged.map((sample) =>
              sample.judgement!.matchingFindingIndices.length > 0
                ? 1 / sample.retainedResult.findings.length
                : 0,
            ),
          ),
    severityAgreement:
      expected.kind === "control" || detections.length === 0
        ? null
        : detections.filter((sample) => matchedSeverity(sample)).length / detections.length,
    severityThresholdAgreement:
      expected.kind === "control" || detections.length === 0
        ? null
        : detections.filter((sample) => matchedThreshold(sample)).length / detections.length,
    judgeCoverage:
      expected.kind === "control" || judgeEligible.length === 0
        ? null
        : judged.length / judgeEligible.length,
    judgeDisagreementRate:
      expected.kind === "control" || judged.length === 0
        ? null
        : judged.filter((sample) => sample.judgement!.disagreement).length / judged.length,
    conclusions,
  }
}

function isGroundedConclusion(sample: EvalSample): boolean {
  if (sample.status === "error") return false
  const expected = sample.expected
  if (expected.kind === "control") {
    return sample.conclusion === "success" && sample.retainedResult.findings.length === 0
  }
  return (
    sample.conclusion === expectedConclusion(expected) &&
    sample.judgement !== null &&
    sample.judgement.matchingFindingIndices.length > 0 &&
    matchedThreshold(sample)
  )
}

function matchedSeverity(sample: Extract<EvalSample, { status: "completed" }>): boolean {
  const expectedSeverity = sample.expected.issue?.severity
  return (
    expectedSeverity !== undefined &&
    (sample.judgement?.matchingFindingIndices.some(
      (index) => sample.retainedResult.findings[index]?.severity === expectedSeverity,
    ) ?? false)
  )
}

function matchedThreshold(sample: Extract<EvalSample, { status: "completed" }>): boolean {
  const expectedBlocking = sample.expected.kind === "blocking"
  return (
    sample.judgement?.matchingFindingIndices.some((index) => {
      const finding = sample.retainedResult.findings[index]
      return finding && isBlockingSeverity(finding.severity, "high") === expectedBlocking
    }) ?? false
  )
}

function mean(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null)
  if (present.length === 0) return null
  return present.reduce((total, value) => total + value, 0) / present.length
}
