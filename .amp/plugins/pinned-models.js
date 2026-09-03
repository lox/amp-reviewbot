// @amp-agent-mode {"key":"reviewbot-v1","label":"reviewbot-v1"}
// @amp-agent-mode {"key":"reviewbot-judge-v1","label":"reviewbot-judge-v1"}

export const description =
  "Pins amp-reviewbot's main agents while retaining Amp's built-in prompts and tools. Install this exact file for every Amp account that runs reviews or evaluation checks."

const model = "openai/gpt-5.6-sol"

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
}
