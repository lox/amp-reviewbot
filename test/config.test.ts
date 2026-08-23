import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { loadConfig, resolveAmpProject } from "../src/config.js"

describe("Amp project resolution", () => {
  it("defaults to the GitHub owner/repository", () => {
    const config = testConfig()
    assert.equal(resolveAmpProject(config, "lox/amp-reviewbot"), "lox/amp-reviewbot")
  })

  it("uses case-insensitive configured overrides", () => {
    const config = testConfig({ AMP_PROJECTS: '{"Lox/Amp-Reviewbot":"workspace/reviewer"}' })
    assert.equal(resolveAmpProject(config, "lox/amp-reviewbot"), "workspace/reviewer")
  })
})

function testConfig(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    DATABASE_URL: "postgres://localhost/reviewbot",
    GITHUB_APP_ID: "123",
    GITHUB_PRIVATE_KEY: "test-private-key",
    GITHUB_WEBHOOK_SECRET: "a-long-test-secret",
    AMP_API_KEY: "test-amp-key",
    ...overrides,
  })
}
