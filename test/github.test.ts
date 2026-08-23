import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parseChangedLines } from "../src/github.js"

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
