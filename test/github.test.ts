import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { checkTitle, parseChangedLines } from "../src/github.js"

describe("checkTitle", () => {
  it("describes clean, advisory, and blocking results", () => {
    assert.equal(checkTitle(0, "success"), "No issues found")
    assert.equal(checkTitle(1, "neutral"), "1 advisory issue")
    assert.equal(checkTitle(2, "failure"), "2 blocking issues")
  })
})

describe("parseChangedLines", () => {
  it("returns right-side line numbers for additions across hunks", () => {
    const patch = `@@ -2,4 +2,5 @@
 context
-removed
+first addition
+second addition
 context
@@ -20,2 +21,3 @@
 context
+later addition
 context`

    assert.deepEqual([...parseChangedLines(patch)], [3, 4, 22])
  })

  it("handles a newly added file", () => {
    const patch = `@@ -0,0 +1,2 @@
+one
+two`
    assert.deepEqual([...parseChangedLines(patch)], [1, 2])
  })
})
