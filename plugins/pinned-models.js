// @amp-agent-mode {"key":"reviewbot-v1","label":"reviewbot-v1"}
// @amp-agent-mode {"key":"reviewbot-judge-v1","label":"reviewbot-judge-v1"}

export const description =
  "Pins amp-reviewbot's main agents and prepares frozen source for evaluations. Install this exact file for every Amp account that runs reviews or evaluation checks."

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
