import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises"
import { basename, dirname, join, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import { parseChangedLines } from "../src/github.js"
import {
  corpusSchema,
  exampleOriginSchema,
  exampleSplitSchema,
  issueCategorySchema,
  issueNatureSchema,
  issueSubtypeSchema,
  pullRequestContextSchema,
  type EvalCorpus,
} from "./schema.js"

const execFileAsync = promisify(execFile)
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/i, "must be a full 40-character commit SHA")
const nameSchema = z
  .string()
  .max(100)
  .regex(
    /^(?!.*(?:\.\.|\.lock$))[a-z0-9](?:[a-z0-9._-]*[a-z0-9_-])?$/i,
    "must be a simple name safe for Git references",
  )
const relativePathSchema = z.string().min(1).max(1_000).superRefine((value, context) => {
  if (value.startsWith("/") || value.split(/[\\/]/).includes("..")) {
    context.addIssue({ code: "custom", message: "must stay inside the example directory" })
  }
})

const packIssueSchema = z
  .object({
    id: z.string().min(1).max(200),
    severity: z.enum(["critical", "high", "medium", "low"]),
    rootCause: z.string().min(1).max(8_000),
    failureBehavior: z.string().min(1).max(8_000),
    path: relativePathSchema,
    line: z.number().int().positive(),
    verification: z.string().min(1).max(8_000),
    witness: relativePathSchema.optional(),
    nature: issueNatureSchema.optional(),
    category: issueCategorySchema.optional(),
    subtype: issueSubtypeSchema.optional(),
  })
  .strict()
  .superRefine((issue, context) => {
    if (issue.nature === "maintainability-advisory") {
      if (issue.category !== "maintainability") {
        context.addIssue({
          code: "custom",
          path: ["category"],
          message: "a maintainability advisory must use the maintainability category",
        })
      }
      if (issue.severity === "critical" || issue.severity === "high") {
        context.addIssue({
          code: "custom",
          path: ["severity"],
          message: "a maintainability advisory cannot be blocking",
        })
      }
    }
    if (issue.category === "maintainability" && issue.nature === "behavioral-defect") {
      context.addIssue({
        code: "custom",
        path: ["nature"],
        message: "the maintainability category must be recorded as an advisory",
      })
    }
    if (issue.subtype && issue.category !== "maintainability") {
      context.addIssue({
        code: "custom",
        path: ["subtype"],
        message: "duplication and non-idiomatic Go are maintainability subtypes",
      })
    }
  })

export const exampleSchema = z
  .object({
    formatVersion: z.literal(1),
    id: nameSchema,
    origin: exampleOriginSchema.optional(),
    split: exampleSplitSchema.optional(),
    source: z
      .object({
        repository: z.string().regex(/^[^/]+\/[^/]+$/),
        pullRequest: z.number().int().positive(),
        baseCommit: shaSchema,
        context: pullRequestContextSchema,
      })
      .strict(),
    versions: z
      .array(
        z
          .object({
            name: nameSchema,
            commit: shaSchema,
            knownIssues: z.array(packIssueSchema).max(20),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((example, context) => {
    if (
      (example.origin === "human-review" || example.origin === "synthetic") &&
      !example.split
    ) {
      context.addIssue({
        code: "custom",
        path: ["split"],
        message: "benchmark examples must declare development or holdout",
      })
    }
    if (example.origin === "human-review") {
      if (example.versions.length !== 1 || example.versions[0]?.knownIssues.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["versions"],
          message: "a human-review example must have one reviewed version with a known issue",
        })
      }
    }
    if (example.origin === "synthetic") {
      const cleanVersions = example.versions.filter((version) => version.knownIssues.length === 0)
      const changedVersions = example.versions.filter((version) => version.knownIssues.length === 1)
      if (
        example.versions.length !== 2 ||
        cleanVersions.length !== 1 ||
        changedVersions.length !== 1
      ) {
        context.addIssue({
          code: "custom",
          path: ["versions"],
          message: "a synthetic example must have one clean version and one single-issue version",
        })
      }
    }
    const names = new Set<string>()
    const commits = new Set<string>()
    example.versions.forEach((version, versionIndex) => {
      if (names.has(version.name)) {
        context.addIssue({
          code: "custom",
          path: ["versions", versionIndex, "name"],
          message: `duplicate version name: ${version.name}`,
        })
      }
      if (commits.has(version.commit)) {
        context.addIssue({
          code: "custom",
          path: ["versions", versionIndex, "commit"],
          message: "each version must use a different commit",
        })
      }
      names.add(version.name)
      commits.add(version.commit)

      const issueIds = new Set<string>()
      version.knownIssues.forEach((issue, issueIndex) => {
        if (
          (example.origin === "human-review" || example.origin === "synthetic") &&
          (!issue.nature || !issue.category)
        ) {
          context.addIssue({
            code: "custom",
            path: ["versions", versionIndex, "knownIssues", issueIndex],
            message: "benchmark issues must declare their nature and category",
          })
        }
        if (
          example.origin === "synthetic" &&
          issue.category === "maintainability" &&
          !issue.subtype
        ) {
          context.addIssue({
            code: "custom",
            path: ["versions", versionIndex, "knownIssues", issueIndex, "subtype"],
            message: "synthetic maintainability issues must declare duplication or non-idiomatic Go",
          })
        }
        if (issueIds.has(issue.id)) {
          context.addIssue({
            code: "custom",
            path: ["versions", versionIndex, "knownIssues", issueIndex, "id"],
            message: `duplicate known issue id: ${issue.id}`,
          })
        }
        issueIds.add(issue.id)
      })
    })
  })

type Example = z.infer<typeof exampleSchema>

type CheckedExample = {
  directory: string
  definition: Example
  bundlePath: string | null
}

export type PackSummary = {
  examples: number
  versions: number
  knownIssues: number
}

export type LoadedPack = {
  corpus: EvalCorpus
  sourcePreparation: Map<string, string>
}

export async function checkPack(inputPath: string): Promise<{
  checked: CheckedExample[]
  summary: PackSummary
}> {
  const exampleFiles = await discoverExampleFiles(resolve(inputPath))
  const checked = await Promise.all(exampleFiles.map(checkExample))
  const ids = new Set<string>()
  for (const [index, example] of checked.entries()) {
    if (ids.has(example.definition.id)) {
      throw new Error(`Duplicate example id in ${exampleFiles[index]}: ${example.definition.id}`)
    }
    ids.add(example.definition.id)
  }
  return {
    checked,
    summary: {
      examples: checked.length,
      versions: checked.reduce((total, example) => total + example.definition.versions.length, 0),
      knownIssues: checked.reduce(
        (total, example) =>
          total +
          example.definition.versions.reduce(
            (versionTotal, version) => versionTotal + version.knownIssues.length,
            0,
          ),
        0,
      ),
    },
  }
}

export async function loadPack(
  inputPath: string,
  sourceCache: string,
  sourceUrl: (repository: string) => string = publicSourceUrl,
): Promise<LoadedPack> {
  const { checked } = await checkPack(inputPath)
  const cases: EvalCorpus["cases"] = []
  const sourcePreparation = new Map<string, string>()

  for (const checkedExample of checked) {
    const resolvedExample = await resolveExample(checkedExample, sourceCache, sourceUrl)
    cases.push(...resolvedExample.cases)
    for (const [caseId, preparation] of resolvedExample.sourcePreparation) {
      sourcePreparation.set(caseId, preparation)
    }
  }

  const version = `pack-v1-${hash(
    JSON.stringify(checked.map((example) => example.definition)),
  ).slice(0, 16)}`
  return {
    corpus: corpusSchema.parse({ version, cases }),
    sourcePreparation,
  }
}

async function discoverExampleFiles(inputPath: string): Promise<string[]> {
  const input = await stat(inputPath).catch(() => null)
  if (!input) throw new Error(`Example pack does not exist: ${inputPath}`)
  if (input.isFile()) {
    if (basename(inputPath) !== "example.json") {
      throw new Error("The input file must be named example.json")
    }
    return [inputPath]
  }

  const direct = join(inputPath, "example.json")
  if ((await stat(direct).catch(() => null))?.isFile()) return [direct]

  const examplesDirectory = join(inputPath, "examples")
  const entries = await readdir(examplesDirectory, { withFileTypes: true }).catch(() => null)
  if (!entries) throw new Error(`No examples found under ${examplesDirectory}`)
  const files = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(examplesDirectory, entry.name, "example.json"))
    .sort()
  if (files.length === 0) throw new Error(`No examples found under ${examplesDirectory}`)
  return files
}

async function checkExample(examplePath: string): Promise<CheckedExample> {
  const input: unknown = JSON.parse(await readFile(examplePath, "utf8"))
  const definition = exampleSchema.parse(input)
  const directory = dirname(examplePath)
  for (const version of definition.versions) {
    for (const issue of version.knownIssues) {
      if (issue.witness) await requireContainedFile(directory, issue.witness)
    }
  }
  const possibleBundle = join(directory, "commits.bundle")
  const bundle = await lstat(possibleBundle).catch(() => null)
  if (bundle?.isSymbolicLink()) throw new Error(`Bundle must not be a symbolic link: ${possibleBundle}`)
  if (bundle && !bundle.isFile()) throw new Error(`Bundle is not a file: ${possibleBundle}`)
  return { directory, definition, bundlePath: bundle ? possibleBundle : null }
}

async function requireContainedFile(directory: string, path: string): Promise<void> {
  const target = resolve(directory, path)
  const root = `${await realpath(directory)}${sep}`
  const resolvedTarget = await realpath(target).catch(() => null)
  if (!resolvedTarget || (!`${resolvedTarget}${sep}`.startsWith(root) && resolvedTarget !== root.slice(0, -1))) {
    throw new Error(`Witness does not exist inside its example directory: ${path}`)
  }
  if (!(await stat(resolvedTarget)).isFile()) throw new Error(`Witness is not a file: ${path}`)
}

async function resolveExample(
  checked: CheckedExample,
  sourceCache: string,
  sourceUrl: (repository: string) => string,
): Promise<Pick<LoadedPack, "sourcePreparation"> & { cases: EvalCorpus["cases"] }> {
  const example = checked.definition
  const repository = await prepareRepository(
    example.source.repository,
    sourceCache,
    sourceUrl(example.source.repository),
  )
  const publicCommits = new Set<string>()

  await requirePublicCommit(repository, example.source.baseCommit)
  publicCommits.add(example.source.baseCommit)
  for (const version of example.versions) {
    if (await isPublicCommit(repository, version.commit)) publicCommits.add(version.commit)
  }

  await clearExampleRefs(repository, example.id)
  const bundleHeads = new Set<string>()
  if (checked.bundlePath) {
    const bundle = await readBundleHeader(checked.bundlePath)
    for (const prerequisite of bundle.prerequisites) {
      await requirePublicCommit(repository, prerequisite)
    }
    for (const head of bundle.heads) bundleHeads.add(head)
    await git(repository, ["bundle", "verify", checked.bundlePath])
    await git(repository, [
      "fetch",
      checked.bundlePath,
      `+refs/heads/*:refs/reviewbot-eval/${example.id}/*`,
    ])
  }

  if (example.origin === "synthetic") {
    const cleanVersion = example.versions.find((version) => version.knownIssues.length === 0)!
    const issueVersion = example.versions.find((version) => version.knownIssues.length === 1)!
    const { stdout } = await git(repository, ["rev-list", "--parents", "-n", "1", issueVersion.commit])
    const parents = stdout.trim().split(/\s+/).slice(1)
    if (parents.length !== 1 || parents[0] !== cleanVersion.commit) {
      throw new Error(
        `Synthetic version ${example.id}/${issueVersion.name} must be one direct commit on top of ${cleanVersion.name}`,
      )
    }
    const mutationLines = await deriveChangedLines(
      repository,
      cleanVersion.commit,
      issueVersion.commit,
    )
    const issue = issueVersion.knownIssues[0]!
    if (!mutationLines[issue.path]?.includes(issue.line)) {
      throw new Error(
        `Known issue ${issue.id} must point to a line changed by the synthetic commit`,
      )
    }
  }

  const cases: EvalCorpus["cases"] = []
  const sourcePreparation = new Map<string, string>()
  for (const version of example.versions) {
    await requireCommit(
      repository,
      version.commit,
      publicCommits.has(version.commit),
      bundleHeads,
      example.id,
      version.name,
    )
    const changedLines = await deriveChangedLines(
      repository,
      example.source.baseCommit,
      version.commit,
    )
    const caseId = `${example.id}/${version.name}`
    cases.push({
      id: caseId,
      seedId: example.id,
      versionName: version.name,
      repositoryFullName: example.source.repository,
      pullNumber: example.source.pullRequest,
      baseSha: example.source.baseCommit,
      headSha: version.commit,
      ...(example.origin ? { origin: example.origin } : {}),
      ...(example.split ? { split: example.split } : {}),
      context: example.source.context,
      changedLines,
      expected: {
        issues: version.knownIssues.map(({ line, ...issue }) => ({
          ...issue,
          changedLine: line,
        })),
      },
    })

    if (!publicCommits.has(version.commit)) {
      sourcePreparation.set(
        caseId,
        await createSourcePreparation(repository, version.commit, [...publicCommits]),
      )
    }
  }
  return { cases, sourcePreparation }
}

async function prepareRepository(
  repository: string,
  sourceCache: string,
  remoteUrl: string,
): Promise<string> {
  const directory = join(resolve(sourceCache), hash(repository).slice(0, 20))
  await mkdir(sourceCache, { recursive: true })
  const gitDirectory = join(directory, ".git")
  if (!(await stat(gitDirectory).catch(() => null))) {
    await rm(directory, { recursive: true, force: true })
    await git(dirname(directory), [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      remoteUrl,
      directory,
    ])
  }
  const { stdout: remote } = await git(directory, ["remote", "get-url", "origin"])
  if (remote.trim() !== remoteUrl) {
    throw new Error(`Source cache has the wrong origin: ${directory}`)
  }
  await git(directory, [
    "fetch",
    "--prune",
    "--prune-tags",
    "origin",
    "+refs/heads/*:refs/remotes/origin/*",
    "+refs/tags/*:refs/tags/*",
  ])
  return directory
}

async function isPublicCommit(repository: string, commit: string): Promise<boolean> {
  try {
    await git(repository, ["cat-file", "-e", `${commit}^{commit}`])
    const { stdout } = await git(repository, [
      "for-each-ref",
      "--format=%(refname)",
      "--contains",
      commit,
      "refs/remotes/origin",
      "refs/tags",
    ])
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

async function requirePublicCommit(repository: string, commit: string): Promise<void> {
  if (!(await isPublicCommit(repository, commit))) {
    throw new Error(`Required base commit is not reachable from a public branch or tag: ${commit}`)
  }
}

async function requireCommit(
  repository: string,
  commit: string,
  isPublic: boolean,
  bundleHeads: ReadonlySet<string>,
  exampleId: string,
  versionName: string,
): Promise<void> {
  if (!isPublic && !bundleHeads.has(commit)) {
    throw new Error(
      `Commit ${commit} for ${exampleId}/${versionName} is not public or advertised by this example's commits.bundle`,
    )
  }
  try {
    await git(repository, ["cat-file", "-e", `${commit}^{commit}`])
  } catch (error) {
    throw new Error(
      `Commit ${commit} for ${exampleId}/${versionName} is not public and was not found in commits.bundle`,
      { cause: error },
    )
  }
}

async function clearExampleRefs(repository: string, exampleId: string): Promise<void> {
  const { stdout } = await git(repository, [
    "for-each-ref",
    "--format=%(refname)",
    `refs/reviewbot-eval/${exampleId}/`,
  ])
  for (const ref of stdout.split("\n").filter(Boolean)) {
    await git(repository, ["update-ref", "-d", ref])
  }
}

async function readBundleHeader(path: string): Promise<{
  heads: string[]
  prerequisites: string[]
}> {
  const contents = await readFile(path)
  const end = contents.indexOf("\n\n")
  if (end === -1) throw new Error(`Invalid Git bundle header: ${path}`)
  const lines = contents.subarray(0, end).toString("utf8").split("\n")
  if (!lines[0]?.startsWith("# v")) throw new Error(`Invalid Git bundle header: ${path}`)
  const heads: string[] = []
  const prerequisites: string[] = []
  for (const line of lines.slice(1)) {
    const prerequisite = /^-([0-9a-f]{40})(?: |$)/i.exec(line)?.[1]
    if (prerequisite) {
      prerequisites.push(prerequisite)
      continue
    }
    const head = /^([0-9a-f]{40}) refs\/heads\//i.exec(line)?.[1]
    if (head) heads.push(head)
  }
  if (heads.length === 0) throw new Error(`Git bundle has no branch heads: ${path}`)
  return { heads, prerequisites }
}

async function deriveChangedLines(
  repository: string,
  baseCommit: string,
  headCommit: string,
): Promise<Record<string, number[]>> {
  const { stdout: names } = await git(repository, [
    "diff",
    "--name-only",
    "-z",
    `${baseCommit}...${headCommit}`,
  ])
  const changedLines: Record<string, number[]> = {}
  for (const path of names.split("\0").filter(Boolean)) {
    const { stdout: patch } = await git(repository, [
      "diff",
      "--no-ext-diff",
      "--unified=0",
      `${baseCommit}...${headCommit}`,
      "--",
      path,
    ])
    const lines = [...parseChangedLines(patch)].sort((left, right) => left - right)
    if (lines.length > 0) changedLines[path] = lines
  }
  return changedLines
}

async function createSourcePreparation(
  repository: string,
  headCommit: string,
  publicCommits: string[],
): Promise<string> {
  const temporaryDirectory = await mkdtemp(join(repository, ".git", "reviewbot-eval-"))
  const bundlePath = join(temporaryDirectory, "commit.bundle")
  const ref = `refs/heads/reviewbot-eval-${headCommit}`
  try {
    await git(repository, ["update-ref", ref, headCommit])
    await git(repository, [
      "bundle",
      "create",
      bundlePath,
      ref,
      ...publicCommits.map((commit) => `^${commit}`),
    ])
    const bundle = await readFile(bundlePath)
    if (bundle.byteLength > 64 * 1024) {
      throw new Error(
        `Generated source transfer for ${headCommit} is ${bundle.byteLength} bytes; the limit is 64 KiB`,
      )
    }
    const advertised = (await git(repository, ["bundle", "list-heads", bundlePath])).stdout
      .trim()
      .split(/\s+/)[1]
    if (!advertised) throw new Error(`Generated source bundle for ${headCommit} has no head`)
    const bundleBase64 = bundle.toString("base64")
    const temporaryBundle = `/tmp/reviewbot-eval-${headCommit}.bundle`
    const publicFetches = publicCommits.map((commit) => `git fetch origin ${commit}`).join("\n")

    return `This exact eval revision includes source history that is not on the public remote. Prepare it before the normal checkout. These bytes contain source history only; they contain no expected answers or focused tests.

Run these commands from the repository:

${publicFetches}
printf '%s' '${bundleBase64}' | base64 --decode > '${temporaryBundle}'
git bundle verify '${temporaryBundle}'
git fetch '${temporaryBundle}' '${advertised}:refs/reviewbot-eval/target'
test "$(git rev-parse refs/reviewbot-eval/target)" = '${headCommit}'
rm -f '${temporaryBundle}'`
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

async function git(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const inherited = [
    "PATH",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "GIT_SSL_CAINFO",
  ]
  const environment: NodeJS.ProcessEnv = {
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  }
  for (const name of inherited) {
    if (process.env[name]) environment[name] = process.env[name]
  }
  return execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
    env: environment,
  })
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function publicSourceUrl(repository: string): string {
  return `https://github.com/${repository}.git`
}

export function describePack(summary: PackSummary): string {
  return `${summary.versions} code ${summary.versions === 1 ? "version" : "versions"} across ${summary.examples} ${summary.examples === 1 ? "example" : "examples"}, with ${summary.knownIssues} known ${summary.knownIssues === 1 ? "issue" : "issues"}`
}
