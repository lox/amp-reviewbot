import { isBlockingSeverity } from "../src/review.js"
import type { EvalRun, EvalSample, ExpectedIssue } from "./schema.js"
import { expectedKind } from "./schema.js"

/**
 * The reviewer's job, as production sees it, is one call per pull request:
 * block it or let it through. A version with a recorded blocking bug gets the
 * right call when the reviewer blocks it for that bug at blocking urgency.
 * Every other version gets the right call when the reviewer does not block it.
 */
export type CaseScore = {
  caseId: string
  kind: "control" | "advisory" | "blocking"
  /** Reviews requested for this version. */
  samples: number
  completed: number
  knownIssues: number
  /** Completed reviews that made the right call. */
  rightCalls: number
  /** Blocking versions: blocked because a recorded blocking bug was reported at blocking urgency. */
  blockedForRecordedBug: number
  /** Blocking versions: blocked, but no recorded blocking bug was reported at blocking urgency. */
  blockedForOtherReason: number
  /** Blocking versions: a recorded blocking bug was reported, but below blocking urgency. */
  foundAtLowerUrgency: number
  /** Blocking versions: no recorded blocking bug was reported at all. */
  missed: number
  /** Non-blocking versions: reviews whose check would have failed. */
  wronglyBlocked: number
  /** Control versions: reviews with no findings at all. */
  quiet: number
  /** Recorded non-blocking issues, counted once per completed review. */
  advisoryChances: number
  advisoryFound: number
  /** Retained findings that matched no recorded issue. Unverified, not wrong. */
  unmatchedFindings: number
  /** Raw findings dropped for not pointing at a changed line. */
  droppedFindings: number
  /** Recorded issues whose comparison with the findings never finished. */
  uncheckedIssues: number
}

export type SeedScore = {
  seedId: string
  pullNumber: number
  origin: EvalRun["cases"][number]["origin"]
  samples: number
  passedSamples: number
  outcome: "pass" | "unstable" | "fail"
}

export type Scorecard = {
  badPrs: {
    versions: number
    reviews: number
    blocked: number
    blockedForOtherReason: number
    foundAtLowerUrgency: number
    missed: number
    versionsRightEveryTime: number
  }
  okPrs: { versions: number; reviews: number; wronglyBlocked: number; versionsRightEveryTime: number }
  cleanPrs: { versions: number; reviews: number; quiet: number }
  advisoryIssues: { chances: number; found: number }
}

export type EvalScore = {
  cases: CaseScore[]
  seeds: SeedScore[]
  scorecard: Scorecard
  reviews: number
  completedReviews: number
  uncheckedIssues: number
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
    .map(([caseId, samples]) => scoreCase(caseId, samples, run.requestedSamplesPerCase))
  const casesBySeed = new Map<string, EvalRun["cases"]>()
  for (const evalCase of run.cases) {
    const seedCases = casesBySeed.get(evalCase.seedId) ?? []
    seedCases.push(evalCase)
    casesBySeed.set(evalCase.seedId, seedCases)
  }
  const seeds = [...casesBySeed.entries()].map(([seedId, seedCases]) => {
    const passedSamples = Array.from(
      { length: run.requestedSamplesPerCase },
      (_, index) => index + 1,
    ).filter((sampleNumber) =>
      seedCases.every((evalCase) => {
        const sample = byCase.get(evalCase.id)?.find((candidate) => candidate.sample === sampleNumber)
        return sample !== undefined && isRightCall(sample)
      }),
    ).length
    return {
      seedId,
      pullNumber: seedCases[0]!.pullNumber,
      origin: seedCases[0]!.origin,
      samples: run.requestedSamplesPerCase,
      passedSamples,
      outcome: seedOutcome(passedSamples, run.requestedSamplesPerCase),
    }
  })

  const blocking = cases.filter((item) => item.kind === "blocking")
  const nonBlocking = cases.filter((item) => item.kind !== "blocking")
  const controls = cases.filter((item) => item.kind === "control")
  const sum = (items: CaseScore[], pick: (item: CaseScore) => number) =>
    items.reduce((total, item) => total + pick(item), 0)
  const rightEveryTime = (items: CaseScore[]) => items.filter(isRightEveryTime).length

  return {
    cases,
    seeds,
    scorecard: {
      badPrs: {
        versions: blocking.length,
        reviews: sum(blocking, (item) => item.completed),
        blocked: sum(blocking, (item) => item.blockedForRecordedBug),
        blockedForOtherReason: sum(blocking, (item) => item.blockedForOtherReason),
        foundAtLowerUrgency: sum(blocking, (item) => item.foundAtLowerUrgency),
        missed: sum(blocking, (item) => item.missed),
        versionsRightEveryTime: rightEveryTime(blocking),
      },
      okPrs: {
        versions: nonBlocking.length,
        reviews: sum(nonBlocking, (item) => item.completed),
        wronglyBlocked: sum(nonBlocking, (item) => item.wronglyBlocked),
        versionsRightEveryTime: rightEveryTime(nonBlocking),
      },
      cleanPrs: {
        versions: controls.length,
        reviews: sum(controls, (item) => item.completed),
        quiet: sum(controls, (item) => item.quiet),
      },
      advisoryIssues: {
        chances: sum(cases, (item) => item.advisoryChances),
        found: sum(cases, (item) => item.advisoryFound),
      },
    },
    reviews: run.samples.length,
    completedReviews: sum(cases, (item) => item.completed),
    uncheckedIssues: sum(cases, (item) => item.uncheckedIssues),
  }
}

/** Every requested repeat completed and made the right call. */
export function isRightEveryTime(item: CaseScore): boolean {
  return item.completed === item.samples && item.rightCalls === item.samples
}

function scoreCase(caseId: string, samples: EvalSample[], requestedSamples: number): CaseScore {
  const expected = samples[0]!.expected
  const kind = expectedKind(expected)
  const completed = samples.filter((sample): sample is CompletedSample => sample.status === "completed")
  const advisoryIssues = expected.issues.filter((issue) => !isBlocking(issue.severity))

  let blockedForRecordedBug = 0
  let blockedForOtherReason = 0
  let foundAtLowerUrgency = 0
  let missed = 0
  let wronglyBlocked = 0
  let quiet = 0
  let advisoryFound = 0
  let unmatchedFindings = 0
  let uncheckedIssues = 0

  for (const sample of completed) {
    const assignment = assignFindings(sample)
    unmatchedFindings += sample.retainedResult.findings.length - assignment.size
    advisoryFound += advisoryIssues.filter((issue) => assignment.has(issue.id)).length
    if (sample.retainedResult.findings.length > 0) {
      uncheckedIssues += expected.issues.length - sample.judgements.length
    }
    if (kind === "blocking") {
      if (blocksRecordedBug(sample)) blockedForRecordedBug += 1
      else if (sample.conclusion === "failure") blockedForOtherReason += 1
      else if (describesRecordedBug(sample)) foundAtLowerUrgency += 1
      else missed += 1
    } else {
      if (sample.conclusion === "failure") wronglyBlocked += 1
      if (kind === "control" && sample.retainedResult.findings.length === 0) quiet += 1
    }
  }

  return {
    caseId,
    kind,
    samples: requestedSamples,
    completed: completed.length,
    knownIssues: expected.issues.length,
    rightCalls: completed.filter((sample) => isRightCall(sample)).length,
    blockedForRecordedBug,
    blockedForOtherReason,
    foundAtLowerUrgency,
    missed,
    wronglyBlocked,
    quiet,
    advisoryChances: advisoryIssues.length * completed.length,
    advisoryFound,
    unmatchedFindings,
    droppedFindings: completed.reduce((total, sample) => total + sample.omitted, 0),
    uncheckedIssues,
  }
}

function seedOutcome(passedSamples: number, samples: number): SeedScore["outcome"] {
  if (samples === 3) {
    if (passedSamples === 3) return "pass"
    return passedSamples === 2 ? "unstable" : "fail"
  }
  if (samples === 5) {
    if (passedSamples >= 4) return "pass"
    return passedSamples === 3 ? "unstable" : "fail"
  }
  if (passedSamples === samples) return "pass"
  return passedSamples > samples / 2 ? "unstable" : "fail"
}

function isRightCall(sample: EvalSample): boolean {
  if (sample.status === "error") return false
  if (expectedKind(sample.expected) === "blocking") return blocksRecordedBug(sample)
  return sample.conclusion !== "failure"
}

/** A recorded blocking issue matched a finding that itself has blocking urgency. */
/**
 * Some finding was judged to match a recorded blocking issue, whatever its
 * urgency. Read from the judgements directly rather than the one-to-one
 * assignment, so a finding shared with an advisory issue still counts.
 */
function describesRecordedBug(sample: CompletedSample): boolean {
  return sample.judgements.some((judgement) => {
    const issue = sample.expected.issues.find((candidate) => candidate.id === judgement.issueId)
    return issue !== undefined && isBlocking(issue.severity) && judgement.matchingFindingIndices.length > 0
  })
}

function blocksRecordedBug(sample: CompletedSample): boolean {
  const findings = sample.retainedResult.findings
  return sample.judgements.some((judgement) => {
    const issue = sample.expected.issues.find((candidate) => candidate.id === judgement.issueId)
    return (
      issue !== undefined &&
      isBlocking(issue.severity) &&
      judgement.matchingFindingIndices.some((index) => {
        const finding = findings[index]
        return finding !== undefined && isBlocking(finding.severity)
      })
    )
  })
}

function isBlocking(severity: ExpectedIssue["severity"]): boolean {
  return isBlockingSeverity(severity, "high")
}

/**
 * Pairs each recorded issue with at most one finding so a single finding
 * cannot count as two issues (maximum bipartite matching).
 */
function assignFindings(sample: CompletedSample): Map<string, number> {
  const choices = new Map(
    sample.expected.issues.map((issue) => [
      issue.id,
      sample.judgements.find((judgement) => judgement.issueId === issue.id)?.matchingFindingIndices ??
        [],
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
