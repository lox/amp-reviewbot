// @amp-agent-mode {"key":"reviewbot-v1","label":"reviewbot-v1"}
// @amp-agent-mode {"key":"reviewbot-judge-v1","label":"reviewbot-judge-v1"}

export const description =
  "Pins reviewbot agents, prepares evaluation source, and supports opt-in deterministic checkout experiments. Install this exact file for every Amp account that runs reviews or evaluation checks."

const model = "openai/gpt-5.6-sol"
const sourceSetupPrefix = "<reviewbot-source-setup-v1>\n"
const sourceSetupSuffix = "\n</reviewbot-source-setup-v1>"

export default function (amp) {
  const reviewer = amp.createAgent({
    extends: "medium",
    model,
    reasoningEffort: "medium",
    oracle: { model, reasoningEffort: "high" },
    display: { label: "reviewbot-v1" },
  })
  amp.registerAgentMode({
    key: "reviewbot-v1",
    description: "Production code review with a fixed main model. Use for amp-reviewbot reviews.",
    agent: reviewer.definition,
  })

  const judge = amp.createAgent({
    extends: "high",
    model,
    reasoningEffort: "xhigh",
    oracle: { model, reasoningEffort: "high" },
    display: { label: "reviewbot-judge-v1" },
  })
  amp.registerAgentMode({
    key: "reviewbot-judge-v1",
    description: "Evaluation finding comparison with a fixed main model. Use only for amp-reviewbot evaluation.",
    agent: judge.definition,
  })

  amp.on("agent.start", async (event, context) => {
    if (event.message.startsWith("<reviewbot-checkout")) {
      const started = Date.now()
      try {
        const block = /^<reviewbot-checkout-v1>\n([^\n]+)\n<\/reviewbot-checkout-v1>\n/.exec(event.message)
        if (!block || !amp.system.workspaceRoot) throw new Error("Invalid checkout request")
        const coordinates = JSON.parse(block[1])
        const command = checkoutCommand(coordinates)
        const workspacePath = amp.helpers.filePathFromURI(amp.system.workspaceRoot)
        const result = await context.$`cd ${workspacePath} && timeout 120s bash -c ${command}`
        if (result.exitCode !== 0) throw new Error("Checkout failed")
        const timing = { event: "reviewbot_checkout", status: "ready", durationMs: Date.now() - started,
          headSha: coordinates.headSha, baseSha: coordinates.baseSha }
        context.logger.log(JSON.stringify(timing))
        return { message: { content: `Trusted checkout is ready. HEAD and comparison history were verified. Do not fetch or repeat checkout.\n${JSON.stringify(timing)}` } }
      } catch {
        await context.thread.cancel()
        context.logger.log(JSON.stringify({ event: "reviewbot_checkout", status: "failed", durationMs: Date.now() - started }))
        return
      }
    }
    if (!event.message.startsWith("<reviewbot-source-setup")) return

    const end = event.message.indexOf(sourceSetupSuffix, sourceSetupPrefix.length)
    const workspace = amp.system.workspaceRoot
    if (!event.message.startsWith(sourceSetupPrefix) || end < 0 || !workspace) {
      await context.thread.cancel()
      return
    }

    const command = event.message.slice(sourceSetupPrefix.length, end)
    try {
      const workspacePath = amp.helpers.filePathFromURI(workspace)
      const result = await context.$`cd ${workspacePath} && bash -c ${command}`
      if (result.exitCode !== 0) {
        await context.thread.cancel()
        return
      }
    } catch {
      await context.thread.cancel()
      return
    }

    return {
      message: {
        content: "The trusted source setup completed successfully. Do not repeat it.",
      },
    }
  })
}

/** Fixed commands only: no prompt-supplied shell, arbitrary remotes, or setup hooks. */
export function checkoutCommand(coordinates) {
  if (!coordinates || typeof coordinates !== "object" || Array.isArray(coordinates)
    || Object.keys(coordinates).sort().join(",") !== "baseSha,headSha,pullNumber,repository"
    || typeof coordinates.repository !== "string"
    || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(coordinates.repository)
    || !Number.isSafeInteger(coordinates.pullNumber) || coordinates.pullNumber < 1
    || typeof coordinates.baseSha !== "string" || !/^[a-f0-9]{40}$/.test(coordinates.baseSha)
    || typeof coordinates.headSha !== "string" || !/^[a-f0-9]{40}$/.test(coordinates.headSha)) {
    throw new Error("Invalid checkout coordinates")
  }
  const { repository, pullNumber, baseSha, headSha } = coordinates
  return `set -euo pipefail
export GIT_TERMINAL_PROMPT=0 GIT_LFS_SKIP_SMUDGE=1
case "$(git config --get remote.origin.url)" in
  'https://github.com/${repository}'|'https://github.com/${repository}.git'|'git@github.com:${repository}.git') ;;
  *) echo 'Checkout repository mismatch' >&2; exit 1 ;;
esac
git diff --quiet
git diff --cached --quiet
args=()
if test "$(git rev-parse --is-shallow-repository)" = true; then args+=(--unshallow); fi
git -c core.hooksPath=/dev/null fetch --no-tags --no-recurse-submodules "\${args[@]}" origin '+refs/pull/${pullNumber}/head:refs/reviewbot/head' '+${baseSha}:refs/reviewbot/base'
test "$(git rev-parse refs/reviewbot/head)" = '${headSha}'
test "$(git rev-parse refs/reviewbot/base)" = '${baseSha}'
git merge-base '${baseSha}' '${headSha}' >/dev/null
git -c core.hooksPath=/dev/null -c submodule.recurse=false checkout --detach refs/reviewbot/head
test "$(git rev-parse HEAD)" = '${headSha}'
git diff --quiet
git diff --cached --quiet`
}
