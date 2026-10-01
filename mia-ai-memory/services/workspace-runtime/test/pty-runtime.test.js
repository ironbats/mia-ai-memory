import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { PTY_INPUT_MAX_BYTES, PTY_JSON_MAX_BYTES } from "../src/pty-manager.js"

const waitFor = async (check, description) => {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await delay(20)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const stoppedProcess = pid => {
  try { process.kill(pid, 0) } catch (error) {
    if (error.code === "ESRCH") return true
    throw error
  }
  // A container's PID 1 may not reap an orphaned zombie promptly. It is stopped
  // and cannot execute, even though its PID remains visible until reaped.
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
  return state.status === 0 && state.stdout.trim().startsWith("Z")
}

const runtimeFixture = async (t, { withoutNative = false } = {}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-memory-pty-test-"))
  const root = path.join(directory, "workspace")
  const otherRoot = path.join(directory, "other")
  const home = path.join(directory, "home")
  await fs.mkdir(path.join(root, "subdir"), { recursive: true })
  await fs.mkdir(otherRoot)
  await fs.mkdir(home)
  const socket = net.createServer()
  socket.listen(0, "127.0.0.1")
  await once(socket, "listening")
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  let entrypoint = fileURLToPath(new URL("../src/index.js", import.meta.url))
  if (withoutNative) {
    await fs.cp(path.dirname(entrypoint), path.join(directory, "src"), { recursive: true })
    await fs.writeFile(path.join(directory, "package.json"), '{"type":"module"}')
    entrypoint = path.join(directory, "src", "index.js")
  }
  const child = spawn(process.execPath, [entrypoint], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      HISTFILE: path.join(home, "history"),
      ZDOTDIR: home,
      ENV: "",
      BASH_ENV: "",
      AI_MEMORY_WORKSPACE_RUNTIME_HOST: "127.0.0.1",
      AI_MEMORY_WORKSPACE_RUNTIME_PORT: String(port),
      AI_MEMORY_WORKSPACE_RUNTIME_REGISTRY: path.join(directory, "registry.json"),
      AI_MEMORY_WORKSPACE_ORIGINS: "http://localhost:5173"
    },
    stdio: ["ignore", "pipe", "pipe"]
  })
  let diagnostics = ""
  child.stdout.setEncoding("utf8").on("data", data => { diagnostics += data })
  child.stderr.setEncoding("utf8").on("data", data => { diagnostics += data })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close")
      child.kill("SIGTERM")
      await closed
    }
    await fs.rm(directory, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${port}`
  const health = await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Runtime exited: ${diagnostics}`)
    try { return await (await fetch(`${base}/healthz`)).json() } catch { return null }
  }, "runtime startup")
  const pair = await (await fetch(`${base}/api/v1/runtime/pair`, { method: "POST" })).json()
  const request = async (suffix, { expect = 200, ...options } = {}) => {
    const response = await fetch(`${base}/api/v1/runtime${suffix}`, {
      ...options,
      headers: { "Content-Type": "application/json", "X-AI-Memory-Workspace-Token": pair.token, ...options.headers }
    })
    const body = await response.json()
    assert.equal(response.status, expect, JSON.stringify(body))
    return body
  }
  const register = async directory => (await request("/workspaces/register", { method: "POST", body: JSON.stringify({ path: directory }), expect: 201 })).workspace
  const workspace = await register(root)
  const other = await register(otherRoot)
  return { base, child, root, health, pair, request, workspace, other }
}

test("missing native module advertises fallback and leaves command API alive", { timeout: 15000 }, async t => {
  const { health, pair, workspace, request } = await runtimeFixture(t, { withoutNative: true })
  assert.equal(health.pty, false)
  assert.equal(health.terminal, true)
  assert.equal(pair.runtime.pty, false)
  assert.ok(health.ptyReason)
  const prefix = `/workspaces/${workspace.id}`
  assert.equal((await request(`${prefix}/terminal/pty`, { method: "POST", body: "{}", expect: 503 })).code, "PTY_UNAVAILABLE")
  const { session } = await request(`${prefix}/terminal/commands`, { method: "POST", body: JSON.stringify({ command: "echo COMMAND_FALLBACK_OK" }), expect: 201 })
  const completed = await waitFor(async () => {
    const result = await request(`${prefix}/terminal/sessions/${session.id}`)
    return result.session.running ? null : result.session
  }, "fallback command")
  assert.match(completed.output, /COMMAND_FALLBACK_OK/)
  assert.equal(completed.exitCode, 0)
})

test("PTY HTTP API with real interactive shell", { timeout: 30000 }, async t => {
  const { base, child, root, health, pair, request, workspace, other } = await runtimeFixture(t)
  if (!health.pty) { t.skip("node-pty native build unavailable"); return }
  assert.equal(pair.runtime.pty, true)
  const prefix = `/workspaces/${workspace.id}`
  const otherPrefix = `/workspaces/${other.id}`
  const create = (body = {}, route = prefix, expect = 201) => request(`${route}/terminal/pty`, { method: "POST", body: JSON.stringify(body), expect })
  const initial = await create({ cols: 92, rows: 27, clientId: "main-tab", shell: "/not-client-controlled", cwd: "/" })
  const id = initial.session.id
  const terminal = `${prefix}/terminal/pty/${id}`
  let output = initial.session.output
  let cursor = initial.session.nextCursor
  const read = async () => {
    const { session } = await request(`${terminal}?cursor=${cursor}&waitMs=100`)
    output += session.output
    cursor = session.nextCursor
    return session
  }
  const input = async data => {
    const result = await request(`${terminal}/input`, { method: "POST", body: JSON.stringify({ data }) })
    assert.equal(result.session.output, "")
    return result.session
  }
  const until = async regex => waitFor(async () => { await read(); return regex.test(output) }, String(regex))

  await t.test("auth, origin, registered workspace and session ownership gates cover all routes", async () => {
    for (const [suffix, method, body] of [
      ["", "GET"], ["", "POST", {}], [`/${id}`, "GET"], [`/${id}`, "DELETE"],
      [`/${id}/input`, "POST", { data: "bad" }], [`/${id}/resize`, "POST", { cols: 80, rows: 24 }]
    ]) {
      const response = await fetch(`${base}/api/v1/runtime${prefix}/terminal/pty${suffix}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) })
      assert.equal(response.status, 401)
    }
    assert.equal((await request(`${prefix}/terminal/pty`, { headers: { Origin: "http://untrusted.example" }, expect: 403 })).code, "ORIGIN_NOT_ALLOWED")
    assert.equal((await request("/workspaces/missing/terminal/pty", { expect: 404 })).code, "WORKSPACE_NOT_REGISTERED")
    for (const [suffix, method, body] of [
      ["", "GET"], ["", "DELETE"], ["/input", "POST", { data: "bad" }], ["/resize", "POST", { cols: 80, rows: 24 }]
    ]) {
      assert.equal((await request(`${otherPrefix}/terminal/pty/${id}${suffix}`, { method, ...(body ? { body: JSON.stringify(body) } : {}), expect: 404 })).code, "TERMINAL_NOT_FOUND")
    }
  })

  await t.test("native TTY preserves color, Unicode and persistent shell state", { skip: process.platform === "win32" }, async () => {
    assert.equal(initial.session.cwd, root)
    assert.notEqual(initial.session.shell, "/not-client-controlled")
    assert.equal((await create({ clientId: "main-tab" }, prefix, 200)).session.id, id)
    await input("test -t 0 && test -t 1 && printf '\\n__TTY_OK__\\n'; printf '\\033[31mRED_🙂é\\033[0m\\n'\r")
    await until(/\x1b\[31mRED_🙂é\x1b\[0m\r?\n/)
    assert.match(output, /\r?\n__TTY_OK__\r?\n/)
    await input("cd subdir; export PTY_FIXTURE_VALUE=persistent; printf '\\n__STATE_%s__\\n' \"$PTY_FIXTURE_VALUE\"; pwd\r")
    await until(/\r?\n__STATE_persistent__\r?\n/)
    assert.ok(output.includes(path.join(root, "subdir")))
    assert.equal(output.includes("\ufffd"), false)
  })

  await t.test("resize changes actual TTY geometry; Ctrl+C interrupts a foreground job", { skip: process.platform === "win32" }, async () => {
    const resized = await request(`${terminal}/resize`, { method: "POST", body: JSON.stringify({ cols: 120, rows: 45 }) })
    assert.equal(resized.session.output, "")
    await input("stty size; printf '\\n__SLEEPING__\\n'; sleep 30\r")
    await until(/\r?\n__SLEEPING__\r?\n/)
    assert.match(output, /[\r\n]45 120\r?\n/)
    await input("\x03")
    await input("printf '\\n__AFTER_INTERRUPT__\\n'\r")
    await until(/\r?\n__AFTER_INTERRUPT__\r?\n/)
  })

  await t.test("payload validation, replay, list and canceled long polls stay usable", async () => {
    assert.equal((await request(`${terminal}?cursor=invalid`, { expect: 400 })).code, "INVALID_TERMINAL_CURSOR")
    assert.equal((await request(`${terminal}?waitMs=20001`, { expect: 400 })).code, "INVALID_TERMINAL_WAIT")
    await request(`${terminal}/resize`, { method: "POST", body: '{"cols":0,"rows":24}', expect: 400 })
    await request(`${terminal}/resize`, { method: "POST", body: "{}", expect: 400 })
    await request(`${terminal}/input`, { method: "POST", body: "null", expect: 400 })
    await request(`${terminal}/input`, { method: "POST", body: JSON.stringify({ data: "x".repeat(PTY_INPUT_MAX_BYTES + 1) }), expect: 413 })
    await request(`${terminal}/input`, { method: "POST", body: JSON.stringify({ data: "x".repeat(PTY_JSON_MAX_BYTES + 1) }), expect: 413 })
    const listed = (await request(`${prefix}/terminal/pty`)).sessions
    assert.equal(listed.length, 1)
    assert.equal(listed[0].output, "")
    const replay = (await request(`${terminal}?cursor=0&waitMs=0`)).session
    assert.equal(replay.id, id)
    assert.ok(replay.output.length >= output.length)
    cursor = replay.nextCursor
    output = replay.output
    for (let index = 0; index < 12; index += 1) {
      const controller = new AbortController()
      const pending = fetch(`${base}/api/v1/runtime${terminal}?cursor=${cursor}`, { headers: { "X-AI-Memory-Workspace-Token": pair.token }, signal: controller.signal })
      await delay(15)
      controller.abort()
      await assert.rejects(pending, { name: "AbortError" })
    }
    await request(`${terminal}?cursor=${cursor}&waitMs=1`)
  })

  await t.test("workspace limit, deletion and runtime shutdown reap native shells", async () => {
    const extra = []
    for (let index = 0; index < 7; index += 1) extra.push((await create()).session)
    assert.equal((await create({}, prefix, 429)).code, "TERMINAL_LIMIT")
    const elsewhere = (await create({ clientId: "main-tab" }, otherPrefix)).session
    assert.notEqual(elsewhere.id, id)
    const descendants = []
    t.after(() => {
      for (const pid of descendants) {
        if (!stoppedProcess(pid)) { try { process.kill(pid, "SIGKILL") } catch {} }
      }
    })
    const resistantChild = async (route, label, background = false) => {
      const script = path.join(root, "resistant-child.cjs")
      const pidFile = path.join(root, `${label}.pid`)
      await fs.writeFile(script, `
        const fs = require("node:fs")
        process.on("SIGHUP", () => {})
        process.on("SIGTERM", () => {})
        setInterval(() => {}, 1000)
        fs.writeFileSync(process.argv[2], String(process.pid))
      `)
      const data = `${quote(process.execPath)} ${quote(script)} ${quote(pidFile)}${background ? " &" : ""}\r`
      await request(`${route}/input`, { method: "POST", body: JSON.stringify({ data }) })
      const pid = await waitFor(async () => {
        try { return Number(await fs.readFile(pidFile, "utf8")) || null } catch { return null }
      }, `${label} child startup`)
      descendants.push(pid)
      return pid
    }
    let foregroundPid, backgroundPid, shutdownPid
    if (process.platform !== "win32") {
      foregroundPid = await resistantChild(`${prefix}/terminal/pty/${extra[0].id}`, "close-foreground")
      backgroundPid = await resistantChild(terminal, "unregister-background", true)
      shutdownPid = await resistantChild(`${otherPrefix}/terminal/pty/${elsewhere.id}`, "shutdown-foreground")
    }
    await request(`${prefix}/terminal/pty/${extra[0].id}`, { method: "DELETE" })
    await request(`${prefix}/terminal/pty/${extra[0].id}?waitMs=0`, { expect: 404 })
    if (foregroundPid) await waitFor(() => stoppedProcess(foregroundPid), "closed terminal's resistant foreground child")
    await request(prefix, { method: "DELETE" })
    assert.equal((await request(`${otherPrefix}/terminal/pty`)).sessions.length, 1)
    if (process.platform !== "win32") {
      await waitFor(() => {
        for (const session of [initial.session, ...extra]) {
          try { process.kill(session.pid, 0); return false } catch (error) { if (error.code !== "ESRCH") throw error }
        }
        return true
      }, "deleted workspace PTYs")
      await waitFor(() => stoppedProcess(backgroundPid), "unregistered terminal's resistant background child")
    }
    const closed = once(child, "close")
    child.kill("SIGTERM")
    const [code] = await closed
    assert.equal(code, 0)
    if (process.platform !== "win32") assert.throws(() => process.kill(elsewhere.pid, 0), { code: "ESRCH" })
    if (shutdownPid) await waitFor(() => stoppedProcess(shutdownPid), "shutdown terminal's resistant foreground child")
  })
})
