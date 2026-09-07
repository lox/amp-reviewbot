import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { z } from "zod"
import { isBlockingSeverity } from "../src/review.js"
import { expectedKind, type EvalCase, type EvalRun, type EvalSample } from "./schema.js"

const setNameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i)
const frozenSetSchema = z
  .object({
    formatVersion: z.literal(1),
    name: setNameSchema,
    cases: z
      .array(
        z
          .object({ example: setNameSchema, version: setNameSchema })
          .strict(),
      )
      .length(16),
  })
  .strict()

export type AbVariant = "A" | "B"
export type AbTask = { evalCase: EvalCase; variant: AbVariant }

export async function loadFrozenSet(
  packPath: string,
  setName: string,
  availableCases: EvalCase[],
): Promise<{ identifier: string; cases: EvalCase[] }> {
  const definition = frozenSetSchema.parse(
    JSON.parse(await readFile(resolve(packPath, "sets", `${setName}.json`), "utf8")),
  )
  if (definition.name !== setName) throw new Error(`Frozen set name is ${definition.name}, not ${setName}`)
  const byId = new Map(availableCases.map((evalCase) => [evalCase.id, evalCase]))
  const ids = definition.cases.map(({ example, version }) => `${example}/${version}`)
  if (new Set(ids).size !== ids.length) throw new Error(`Frozen set ${setName} contains a duplicate version`)
  const cases = ids.map((id) => {
    const evalCase = byId.get(id)
    if (!evalCase) throw new Error(`Frozen set ${setName} names unknown version ${id}`)
    if (evalCase.split === "holdout") {
      throw new Error(`Frozen set ${setName} must not contain holdout version ${id}`)
    }
    return evalCase
  })
  const counts = { blocking: 0, control: 0, advisory: 0 }
  for (const evalCase of cases) counts[expectedKind(evalCase.expected)] += 1
  if (counts.blocking !== 10 || counts.control !== 3 || counts.advisory !== 3) {
    throw new Error(
      `Frozen set ${setName} must contain 10 blocking, 3 clean, and 3 advisory-only versions; found ${counts.blocking}, ${counts.control}, and ${counts.advisory}`,
    )
  }
  const hash = createHash("sha256").update(JSON.stringify(definition)).digest("hex").slice(0, 12)
  return { identifier: `${setName}@${hash}`, cases }
}

/** Randomizes pair order and A/B order inside each pair, without separating a version's two reviews. */
export function interleavedAbTasks(cases: EvalCase[], seed: string): AbTask[] {
  return [...cases]
    .sort((left, right) => hash(`${seed}\0pair\0${left.id}`).localeCompare(hash(`${seed}\0pair\0${right.id}`)))
    .flatMap((evalCase) =>
      hash(`${seed}\0side\0${evalCase.id}`).charCodeAt(0) % 2 === 0
        ? [{ evalCase, variant: "A" as const }, { evalCase, variant: "B" as const }]
        : [{ evalCase, variant: "B" as const }, { evalCase, variant: "A" as const }],
    )
}

export function formatAbDecision(input: {
  setIdentifier: string
  promptA: string
  promptB: string
  runA: EvalRun
  runB: EvalRun
  wallTimeMs: number
}): string {
  const samplesA = samplesByCase(input.runA)
  const samplesB = samplesByCase(input.runB)
  const cases = input.runA.cases
  const blocking = cases.filter((evalCase) => expectedKind(evalCase.expected) === "blocking")
  const nonBlocking = cases.filter((evalCase) => expectedKind(evalCase.expected) !== "blocking")
  const blocks = (sample: EvalSample | undefined) => sample?.status === "completed" && sample.conclusion === "failure"
  const completedA = [...samplesA.values()].filter((sample) => sample.status === "completed").length
  const completedB = [...samplesB.values()].filter((sample) => sample.status === "completed").length
  const blockedA = blocking.filter((evalCase) => blocks(samplesA.get(evalCase.id))).length
  const blockedB = blocking.filter((evalCase) => blocks(samplesB.get(evalCase.id))).length
  const falseA = nonBlocking.filter((evalCase) => blocks(samplesA.get(evalCase.id))).length
  const falseB = nonBlocking.filter((evalCase) => blocks(samplesB.get(evalCase.id))).length
  const failures = 2 * cases.length - completedA - completedB
  const paired = cases.filter((evalCase) => {
    const a = samplesA.get(evalCase.id)
    const b = samplesB.get(evalCase.id)
    return a?.status === "completed" && b?.status === "completed"
  })
  const changed = paired.filter(
    (evalCase) => blocks(samplesA.get(evalCase.id)) !== blocks(samplesB.get(evalCase.id)),
  )
  const newNonBlockingBlocks = nonBlocking.some(
    (evalCase) =>
      paired.includes(evalCase) &&
      !blocks(samplesA.get(evalCase.id)) &&
      blocks(samplesB.get(evalCase.id)),
  )
  const blockingLosses = blocking.filter(
    (evalCase) =>
      paired.includes(evalCase) &&
      blocks(samplesA.get(evalCase.id)) &&
      !blocks(samplesB.get(evalCase.id)),
  ).length
  const promising =
    failures === 0 && blockedB - blockedA >= 3 && !newNonBlockingBlocks && blockingLosses < 3
  const recommendation = newNonBlockingBlocks || blockingLosses >= 3
    ? "REGRESSION"
    : promising
      ? "PROMISING B"
      : "KEEP A"
  const lines = [
    `Frozen set: ${input.setIdentifier}`,
    `Prompt A: ${input.promptA}`,
    `Prompt B: ${input.promptB}`,
    `Completed / requested reviews: A ${completedA}/${cases.length}   B ${completedB}/${cases.length}`,
    `Execution failures: ${failures}`,
    `Blocking versions blocked:     A ${blockedA}/10   B ${blockedB}/10`,
    `Non-blocking versions blocked: A ${falseA}/6    B ${falseB}/6`,
    "Changed calls: case | expected | A | B | retained high findings (title, file:line)",
  ]
  if (changed.length === 0) lines.push("  none")
  for (const evalCase of changed) {
    const a = samplesA.get(evalCase.id)
    const b = samplesB.get(evalCase.id)
    lines.push(
      `  ${evalCase.id} | ${expectedKind(evalCase.expected)} | ${call(a)} | ${call(b)} | A: ${highFindings(a)}; B: ${highFindings(b)}`,
    )
  }
  lines.push(`Wall time: ${formatDuration(input.wallTimeMs)}`, `Recommendation: ${recommendation}`)
  if (recommendation === "PROMISING B") {
    lines.push("Human read required: validate the retained high findings behind B's gains before an outer-loop run.")
  } else if (failures > 0) {
    lines.push("Execution failures prevent a PROMISING B verdict because the missing calls could change it.")
  }
  return lines.join("\n")
}

function samplesByCase(run: EvalRun): Map<string, EvalSample> {
  return new Map(run.samples.map((sample) => [sample.caseId, sample]))
}

function call(sample: EvalSample | undefined): string {
  if (!sample || sample.status === "error") return "ERROR"
  return sample.conclusion === "failure" ? "BLOCK" : "PASS"
}

function highFindings(sample: EvalSample | undefined): string {
  if (!sample || sample.status === "error") return "none"
  const findings = sample.retainedResult.findings.filter((finding) =>
    isBlockingSeverity(finding.severity, "high"),
  )
  return findings.length === 0
    ? "none"
    : findings.map((finding) => `${finding.title} (${finding.path}:${finding.startLine})`).join("; ")
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1_000)
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
