export const reviewMode = "review-gpt56sol-v1" as const
export const judgeMode = "judge-gpt56sol-v1" as const
export const pinnedModel = "openai/gpt-5.6-sol" as const

export function agentModeFromMessage(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || !("agent_mode" in message)) return undefined
  return typeof message.agent_mode === "string" ? message.agent_mode : undefined
}
