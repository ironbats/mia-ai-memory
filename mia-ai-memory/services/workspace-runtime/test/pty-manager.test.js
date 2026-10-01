import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { createPtyManager, PTY_INPUT_MAX_BYTES, terminalDimensions } from "../src/pty-manager.js"

const workspace = { id: "one", root: "/tmp/pty-workspace" }
const other = { id: "two", root: "/tmp/pty-other" }
const fixture = (t, options = {}) => {
  const children = []
  let clock = 100000
  const manager = createPtyManager({
    shell: { file: "/bin/test-shell", args: ["-i"] },
    env: { HOME: "/tmp/home" }, sweepMs: 0, now: () => clock,
    spawnPty(file, args, config) {
      const dataListeners = new Set()
      const exitListeners = new Set()
      const child = {
        pid: children.length + 100, file, args, config, writes: [], sizes: [], killed: 0,
        onData(fn) { dataListeners.add(fn); return { dispose: () => dataListeners.delete(fn) } },
        onExit(fn) { exitListeners.add(fn); return { dispose: () => exitListeners.delete(fn) } },
        emit(data) { for (const fn of dataListeners) fn(data) },
        exit(exitCode = 0, signal = 0) { for (const fn of [...exitListeners]) fn({ exitCode, signal }) },
        write(data) { this.writes.push(data) },
        resize(cols, rows) { this.sizes.push([cols, rows]) },
        kill() { this.killed += 1; this.exit(0, 9) },
        get listeners() { return dataListeners.size + exitListeners.size }
      }
      children.push(child)
      return child
    },
    ...options
  })
  t.after(() => manager.dispose())
  return { manager, children, advance: ms => { clock += ms } }
}

test("PTY manager preserves raw ANSI, controls and Unicode using absolute cursors", async t => {
  const { manager, children } = fixture(t, { maxOutputBytes: 15 })
  const { session } = manager.create(workspace, { cols: 120, rows: 35, shell: "/not-allowed", cwd: "/not-allowed" })
  assert.equal(session.shell, "/bin/test-shell")
  assert.equal(session.cwd, workspace.root)
  assert.equal(children[0].config.cwd, workspace.root)
  assert.equal(children[0].config.env.TERM, "xterm-256color")
  assert.equal(children[0].config.encoding, "utf8")
  const text = "\x1b[31mé🙂\r\n"
  children[0].emit(text)
  const initial = await manager.read(workspace.id, session.id, 0, { waitMs: 0 })
  assert.equal(initial.output, text)
  assert.equal(initial.nextCursor, text.length)
  children[0].emit("012345678901234🙂")
  const truncated = await manager.read(workspace.id, session.id, 0, { waitMs: 0 })
  assert.equal(truncated.truncated, true)
  assert.ok(Buffer.byteLength(truncated.output) <= 15)
  assert.ok(!truncated.output.includes("\ufffd"))
  assert.equal(truncated.nextCursor, text.length + 17)
  children[0].emit("TAIL")
  assert.equal((await manager.read(workspace.id, session.id, truncated.nextCursor)).output, "TAIL")
})

test("PTY creation is idempotent only inside its workspace and enforces dimensions and caps", t => {
  const { manager, children } = fixture(t, { maxPerWorkspace: 2, maxSessions: 3 })
  const first = manager.create(workspace, { clientId: "tab-1" })
  const duplicate = manager.create(workspace, { clientId: "tab-1" })
  assert.equal(first.created, true)
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.session.id, first.session.id)
  assert.equal(children.length, 1)
  manager.create(workspace)
  assert.throws(() => manager.create(workspace), { status: 429, code: "TERMINAL_LIMIT" })
  assert.notEqual(manager.create(other, { clientId: "tab-1" }).session.id, first.session.id)
  assert.throws(() => manager.create(other), { status: 429 })
  for (const [cols, rows] of [[0, 24], [501, 24], [80, 0], [80, 301], [1.5, 24], ["80", 24], [null, 24]]) {
    assert.throws(() => terminalDimensions(cols, rows), { status: 400 })
  }
  assert.throws(() => manager.create(workspace, { clientId: "../../bad" }), { status: 400 })
  manager.remove(workspace.id, first.session.id)
  assert.equal(children[0].killed, 1)
  assert.equal(children[0].listeners, 0)
  assert.equal(manager.create(workspace).created, true)
})

test("PTY input and resize are bounded, ordered, workspace-scoped and do not replay output", async t => {
  const { manager, children } = fixture(t)
  const { session } = manager.create(workspace)
  children[0].emit("prompt\r\n")
  for (const value of ["abc", "\x03", "\x1b[A", "🙂\t\r"]) {
    assert.equal(manager.input(workspace.id, session.id, value).output, "")
  }
  assert.deepEqual(children[0].writes, ["abc", "\x03", "\x1b[A", "🙂\t\r"])
  assert.equal(manager.resize(workspace.id, session.id, 100, 40).cols, 100)
  assert.deepEqual(children[0].sizes, [[100, 40]])
  assert.equal(manager.list(workspace.id)[0].output, "")
  assert.throws(() => manager.input(workspace.id, session.id, "x".repeat(PTY_INPUT_MAX_BYTES + 1)), { status: 413 })
  assert.throws(() => manager.input(workspace.id, session.id, {}), { status: 400 })
  assert.throws(() => manager.resize(workspace.id, session.id, undefined, undefined), { status: 400 })
  assert.throws(() => manager.resize(workspace.id, session.id, 80, -1), { status: 400 })
  assert.throws(() => manager.input(other.id, session.id, "bad"), { status: 404 })
  assert.throws(() => manager.resize(other.id, session.id, 80, 24), { status: 404 })
  assert.throws(() => manager.remove(other.id, session.id), { status: 404 })
  await assert.rejects(manager.read(other.id, session.id), { status: 404 })
  await assert.rejects(manager.read(workspace.id, session.id, -1), { status: 400 })
  children[0].exit(7)
  const ended = await manager.read(workspace.id, session.id)
  assert.equal(ended.running, false)
  assert.equal(ended.exitCode, 7)
  assert.throws(() => manager.input(workspace.id, session.id, "bad"), { status: 409 })
})

test("long polling wakes on data, resize, exit, timeout, removal and cancellation without leaking slots", async t => {
  const { manager, children } = fixture(t, { maxWaitersPerSession: 1 })
  const { session } = manager.create(workspace)
  const pending = manager.read(workspace.id, session.id)
  await assert.rejects(manager.read(workspace.id, session.id), { code: "TERMINAL_READER_LIMIT" })
  children[0].emit("hello")
  assert.equal((await pending).output, "hello")
  for (let index = 0; index < 25; index += 1) {
    const controller = new AbortController()
    const request = manager.read(workspace.id, session.id, 5, { signal: controller.signal })
    controller.abort()
    await assert.rejects(request, { name: "AbortError" })
  }
  const resizing = manager.read(workspace.id, session.id, 5)
  manager.resize(workspace.id, session.id, 101, 35)
  assert.equal((await resizing).cols, 101)
  const timing = manager.read(workspace.id, session.id, 5, { waitMs: 5 })
  // Keep the test process alive while the production poll timeout is unref'ed.
  await delay(10)
  assert.equal((await timing).output, "")
  const exiting = manager.read(workspace.id, session.id, 5)
  children[0].exit(12, 9)
  assert.equal((await exiting).exitCode, 12)
  assert.equal(children[0].listeners, 0)
  const second = manager.create(workspace).session
  const removing = manager.read(workspace.id, second.id)
  manager.remove(workspace.id, second.id)
  assert.equal((await removing).removed, true)
})

test("detached and exited TTLs, workspace deletion and shutdown clean up only owned sessions", async t => {
  const { manager, children, advance } = fixture(t, { detachedTtlMs: 100, exitedTtlMs: 20 })
  const first = manager.create(workspace).session
  const second = manager.create(other).session
  advance(80)
  await manager.read(other.id, second.id, 0, { waitMs: 0 })
  children[0].emit("output does not keep a detached session alive")
  advance(25)
  manager.sweep()
  assert.equal(children[0].killed, 1)
  await assert.rejects(manager.read(workspace.id, first.id), { status: 404 })
  assert.equal(manager.list(other.id).length, 1)
  children[1].exit(0)
  advance(20)
  manager.sweep()
  assert.equal(manager.list(other.id).length, 0)
  manager.create(workspace)
  const survivor = manager.create(other).session
  manager.removeWorkspace(workspace.id)
  assert.equal(children[2].killed, 1)
  assert.equal(children[3].killed, 0)
  const waiting = manager.read(other.id, survivor.id)
  manager.dispose()
  assert.equal((await waiting).removed, true)
  assert.equal(children[3].killed, 1)
  assert.throws(() => manager.create(workspace), { status: 503 })
})

test("closing processes count toward limits; spawn and stop failures remain recoverable", t => {
  const { manager, children } = fixture(t, { maxSessions: 1, terminate: child => { child.killed += 1 } })
  const { session } = manager.create(workspace)
  manager.remove(workspace.id, session.id)
  assert.throws(() => manager.create(workspace), { status: 429 })
  children[0].exit(0, 9)
  assert.equal(manager.create(workspace).created, true)
  const missing = fixture(t, { spawnPty: null }).manager
  assert.throws(() => missing.create(workspace), { code: "PTY_UNAVAILABLE" })
  const broken = fixture(t, { spawnPty: () => { throw new Error("native build failed") } }).manager
  assert.throws(() => broken.create(workspace), { code: "PTY_UNAVAILABLE" })
})
