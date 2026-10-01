import assert from "node:assert/strict"
import test from "node:test"
import { appendTerminalOutput, createTerminalOutput, readTerminalOutput } from "../src/terminal-output.js"

test("output cursors retain their existing UTF-16 units before truncation", () => {
  const session = createTerminalOutput()
  assert.deepEqual(readTerminalOutput(session), { output: "", startCursor: 0, nextCursor: 0, truncated: false })
  appendTerminalOutput(session, "hello 🙂")
  assert.equal(session.outputBytes, 10)
  assert.deepEqual(readTerminalOutput(session, 6), { output: "🙂", startCursor: 6, nextCursor: 8, truncated: false })
  assert.equal(readTerminalOutput(session, 8).output, "")
  appendTerminalOutput(session, "!\n")
  assert.deepEqual(readTerminalOutput(session, 8), { output: "!\n", startCursor: 8, nextCursor: 10, truncated: false })
})

test("polling continues after repeated rolling-buffer truncation", () => {
  const session = createTerminalOutput()
  appendTerminalOutput(session, "12345678", 8)
  const first = readTerminalOutput(session)
  appendTerminalOutput(session, "90", 8)
  assert.deepEqual(readTerminalOutput(session, first.nextCursor), { output: "90", startCursor: 8, nextCursor: 10, truncated: false })
  assert.deepEqual(readTerminalOutput(session, 1), { output: "34567890", startCursor: 2, nextCursor: 10, truncated: true })
  assert.equal(readTerminalOutput(session, 2).truncated, false)
  appendTerminalOutput(session, "abcdefghijk", 8)
  assert.deepEqual(readTerminalOutput(session, 10), { output: "defghijk", startCursor: 13, nextCursor: 21, truncated: true })
  appendTerminalOutput(session, "END", 8)
  assert.deepEqual(readTerminalOutput(session, 21), { output: "END", startCursor: 21, nextCursor: 24, truncated: false })
  assert.equal(session.outputBytes, 8)
})

test("retention is bounded in bytes and never splits a Unicode code point", () => {
  const session = createTerminalOutput()
  appendTerminalOutput(session, "é🙂x", 7)
  assert.equal(session.outputBytes, 7)
  appendTerminalOutput(session, "é", 7)
  assert.deepEqual(readTerminalOutput(session), { output: "🙂xé", startCursor: 1, nextCursor: 5, truncated: true })
  appendTerminalOutput(session, "🙂", 7)
  assert.deepEqual(readTerminalOutput(session), { output: "xé🙂", startCursor: 3, nextCursor: 7, truncated: true })
  assert.equal(session.outputBytes, Buffer.byteLength(session.output))
  assert.equal(session.outputBytes, 7)

  const tiny = createTerminalOutput()
  appendTerminalOutput(tiny, "🙂", 3)
  assert.deepEqual(readTerminalOutput(tiny), { output: "", startCursor: 2, nextCursor: 2, truncated: true })
  assert.equal(tiny.outputBytes, 0)
  appendTerminalOutput(tiny, "ok", 3)
  assert.deepEqual(readTerminalOutput(tiny, 2), { output: "ok", startCursor: 2, nextCursor: 4, truncated: false })
})

test("invalid cursors recover from the available beginning and future cursors clamp", () => {
  const session = createTerminalOutput()
  appendTerminalOutput(session, "0123456789", 5)
  for (const cursor of [undefined, null, "", "invalid", "1.2", -1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(readTerminalOutput(session, cursor), { output: "56789", startCursor: 5, nextCursor: 10, truncated: true }, String(cursor))
  }
  assert.deepEqual(readTerminalOutput(session, "7"), { output: "789", startCursor: 7, nextCursor: 10, truncated: false })
  assert.deepEqual(readTerminalOutput(session, 999), { output: "", startCursor: 10, nextCursor: 10, truncated: false })
})

test("a cursor inside a surrogate pair does not return a lone surrogate", () => {
  const session = createTerminalOutput()
  appendTerminalOutput(session, "a🙂b")
  assert.deepEqual(readTerminalOutput(session, 2), { output: "b", startCursor: 3, nextCursor: 4, truncated: false })
})

test("mixed Unicode chunks maintain absolute cursors and a strict byte cap", () => {
  const session = createTerminalOutput()
  const chunks = ["alpha", "é", "🙂", "\n", "你好", "a".repeat(40)]
  let complete = ""
  for (let index = 0; index < 100; index += 1) {
    const chunk = chunks[index % chunks.length]
    complete += chunk
    appendTerminalOutput(session, chunk, 23)
    const result = readTerminalOutput(session)
    assert.equal(result.nextCursor, complete.length)
    assert.equal(result.output, complete.slice(result.startCursor))
    assert.equal(session.outputBytes, Buffer.byteLength(result.output))
    assert.ok(session.outputBytes <= 23)
    assert.equal(result.output.includes("\ufffd"), false)
    assert.equal(result.output.isWellFormed(), true)
  }
})
