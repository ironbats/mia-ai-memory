import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { MAX_TERMINAL_OUTPUT_BYTES } from "../src/terminal-output.js"

const waitFor = async (check, description) => {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await delay(20)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

const freePort = async () => {
  const socket = net.createServer()
  socket.listen(0, "127.0.0.1")
  await once(socket, "listening")
  const port = socket.address().port
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()))
  return port
}

const quote = value => process.platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`

test("runtime terminal API", { timeout: 30000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-memory-runtime-test-"))
  const workspaceRoot = path.join(directory, "workspace")
  const otherRoot = path.join(directory, "other")
  const home = path.join(directory, "home")
  await fs.mkdir(path.join(workspaceRoot, "subdir"), { recursive: true })
  await fs.mkdir(otherRoot)
  await fs.mkdir(home)
  const port = await freePort()
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/index.js", import.meta.url))], {
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
      ...(process.platform === "win32" ? {} : { SHELL: "/bin/bash" })
    },
    stdio: ["ignore", "pipe", "pipe"]
  })
  let diagnostics = ""
  const terminalPids = new Set()
  child.stdout.setEncoding("utf8").on("data", chunk => { diagnostics += chunk })
  child.stderr.setEncoding("utf8").on("data", chunk => { diagnostics += chunk })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close")
      child.kill("SIGTERM")
      await closed
    }
    if (process.platform !== "win32") {
      for (const pid of terminalPids) {
        try { process.kill(-pid, "SIGKILL") } catch {
        }
      }
    }
    await fs.rm(directory, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${port}`
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Runtime exited: ${diagnostics}`)
    try { return (await fetch(`${base}/healthz`)).ok } catch { return false }
  }, "runtime startup")
  const paired = await (await fetch(`${base}/api/v1/runtime/pair`, { method: "POST" })).json()
  const request = async (suffix, options = {}) => {
    const response = await fetch(`${base}/api/v1/runtime${suffix}`, {
      ...options,
      headers: { "Content-Type": "application/json", "X-AI-Memory-Workspace-Token": paired.token, ...options.headers }
    })
    const body = await response.json()
    assert.equal(response.ok, true, JSON.stringify(body))
    return body
  }
  const register = root => request("/workspaces/register", { method: "POST", body: JSON.stringify({ path: root }) })
  const { workspace } = await register(workspaceRoot)
  const { workspace: other } = await register(otherRoot)
  const workspacePath = `/workspaces/${workspace.id}`
  const execute = async command => {
    const result = await request(`${workspacePath}/terminal/commands`, { method: "POST", body: JSON.stringify({ command }) })
    if (result.session.pid) terminalPids.add(result.session.pid)
    return result
  }
  const poll = (id, cursor = 0) => request(`${workspacePath}/terminal/sessions/${id}?cursor=${encodeURIComponent(cursor)}`)
  const runScript = async (name, source, prefix = "") => {
    const script = path.join(workspaceRoot, name)
    await fs.writeFile(script, source)
    return execute(`${prefix}${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} ${quote(script)}`)
  }
  const finished = id => waitFor(async () => {
    const result = await poll(id)
    if (result.session.running) return null
    terminalPids.delete(result.session.pid)
    return result.session
  }, "terminal completion")

  await t.test("built-in cd is identified and preserves workspace boundaries", async () => {
    const { session, cwd } = await execute("cd subdir")
    assert.equal(session.builtin, true)
    assert.equal(session.running, false)
    assert.equal(session.exitCode, 0)
    assert.equal(session.nextCursor, 0)
    assert.equal(session.output, "")
    assert.equal(cwd, "subdir")
    const denied = await fetch(`${base}/api/v1/runtime${workspacePath}/terminal/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AI-Memory-Workspace-Token": paired.token },
      body: JSON.stringify({ command: "cd ../.." })
    })
    assert.equal(denied.status, 403)
    assert.equal((await denied.json()).code, "TERMINAL_PATH_ESCAPE")
    await execute("cd")
  })

  await t.test("separate stdout/stderr decoders preserve split UTF-8 characters", async () => {
    const { session } = await runScript("unicode.cjs", `
      const out = Buffer.from("🙂")
      const err = Buffer.from("é")
      process.stdout.write(out.subarray(0, 2))
      process.stderr.write(err.subarray(0, 1))
      setTimeout(() => {
        process.stdout.write(out.subarray(2))
        process.stderr.write(err.subarray(1))
      }, 50)
    `)
    const result = await finished(session.id)
    assert.equal(result.builtin, false)
    assert.equal(result.exitCode, 0)
    assert.ok(result.output.includes("🙂"))
    assert.ok(result.output.includes("é"))
    assert.equal(result.output.includes("\ufffd"), false)
    assert.equal(result.nextCursor, 3)
    assert.equal(result.truncated, false)
  })

  await t.test("polling receives new output after the 4 MiB retention limit", async () => {
    const length = MAX_TERMINAL_OUTPUT_BYTES + 256
    const gate = path.join(workspaceRoot, "continue")
    const { session } = await runScript("large-output.cjs", `
      const fs = require("node:fs")
      process.stdout.write("x".repeat(${length}))
      const timer = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(gate)})) {
          clearInterval(timer)
          process.stdout.write("TAIL\\n")
        }
      }, 10)
    `)
    const first = await waitFor(async () => {
      const { session: result } = await poll(session.id)
      return result.nextCursor === length ? result : null
    }, "initial large output")
    assert.equal(first.running, true)
    assert.equal(first.output.length, MAX_TERMINAL_OUTPUT_BYTES)
    assert.equal(first.startCursor, 256)
    assert.equal(first.truncated, true)
    await fs.writeFile(gate, "")
    await finished(session.id)
    const { session: tail } = await poll(session.id, first.nextCursor)
    assert.equal(tail.output, "TAIL\n")
    assert.equal(tail.nextCursor, length + 5)
    assert.equal(tail.startCursor, length)
    assert.equal(tail.truncated, false)
    assert.equal((await poll(session.id, tail.nextCursor)).session.output, "")
    const recovered = (await poll(session.id, "invalid")).session
    assert.equal(recovered.output.length, MAX_TERMINAL_OUTPUT_BYTES)
    assert.ok(recovered.output.endsWith("TAIL\n"))
    assert.equal(recovered.truncated, true)

    const unauthorized = await fetch(`${base}/api/v1/runtime${workspacePath}/terminal/sessions/${session.id}`)
    assert.equal(unauthorized.status, 401)
    const wrongWorkspace = await fetch(`${base}/api/v1/runtime/workspaces/${other.id}/terminal/sessions/${session.id}`, {
      headers: { "X-AI-Memory-Workspace-Token": paired.token }
    })
    assert.equal(wrongWorkspace.status, 404)
  })

  await t.test("terminal context exposes bounded recent command output", async () => {
    const { session } = await runScript("terminal-context.cjs", `process.stdout.write("CONTEXT_READY\\nAPI_KEY=terminal-secret-value-123456789\\n")`)
    await finished(session.id)
    const result = await request(`${workspacePath}/terminal/context?maxChars=8192`)
    assert.ok(result.terminal.transcript.includes("CONTEXT_READY"))
    assert.ok(result.terminal.transcript.includes("terminal-context.cjs"))
    assert.ok(result.terminal.transcript.includes("API_KEY=[REDACTED]"))
    assert.equal(result.terminal.transcript.includes("terminal-secret-value-123456789"), false)
    assert.ok(result.terminal.sessionCount >= 1)
    assert.ok(result.terminal.transcript.length <= 8192)
  })

  await t.test("stop escalates for a TERM-resistant process without duplicate requests delaying it", { skip: process.platform === "win32" }, async () => {
    const { session } = await runScript("ignore-term.cjs", `
      process.on("SIGTERM", () => process.stdout.write("IGNORED\\n"))
      setInterval(() => {}, 1000)
      process.stdout.write("READY\\n")
    `, "exec ")
    await waitFor(async () => (await poll(session.id)).session.output.includes("READY"), "signal handler setup")
    const stop = () => request(`${workspacePath}/terminal/sessions/${session.id}`, { method: "DELETE" })
    assert.equal((await stop()).stopped, true)
    await waitFor(async () => (await poll(session.id)).session.output.includes("IGNORED"), "ignored SIGTERM")
    // Keep sending stop requests past the grace interval: escalation must not reset.
    const completed = await waitFor(async () => {
      const result = (await poll(session.id)).session
      if (!result.running) return result
      // Completion may race this request after the running snapshot above.
      await stop()
      return null
    }, "forced terminal stop")
    assert.equal(completed.signal, "SIGKILL")
    assert.equal(completed.running, false)
    assert.equal((await stop()).stopped, false)
    terminalPids.delete(session.pid)
  })

  await t.test("stop also terminates resistant descendants after their shell exits", { skip: process.platform === "win32" }, async () => {
    const script = path.join(workspaceRoot, "ignore-term-child.cjs")
    await fs.writeFile(script, `
      process.on("SIGTERM", () => process.stdout.write("IGNORED\\n"))
      setInterval(() => {}, 1000)
      process.stdout.write("READY\\n")
    `)
    const { session } = await execute(`${quote(process.execPath)} ${quote(script)} & wait`)
    await waitFor(async () => (await poll(session.id)).session.output.includes("READY"), "descendant signal handler setup")
    assert.equal((await request(`${workspacePath}/terminal/sessions/${session.id}`, { method: "DELETE" })).stopped, true)
    const result = await finished(session.id)
    assert.equal(result.running, false)
    assert.ok(result.output.includes("IGNORED"))
  })

  await t.test("unregister stops its running terminals and preserves other workspaces", { skip: process.platform === "win32" }, async () => {
    const { session } = await runScript("unregister-term.cjs", `
      process.on("SIGTERM", () => {})
      setInterval(() => {}, 1000)
      process.stdout.write("READY\\n")
    `, "exec ")
    await waitFor(async () => (await poll(session.id)).session.output.includes("READY"), "unregister fixture setup")
    assert.equal((await request(workspacePath, { method: "DELETE" })).removed, true)
    await waitFor(async () => {
      try {
        process.kill(session.pid, 0)
        return false
      } catch (error) {
        if (error.code === "ESRCH") return true
        throw error
      }
    }, "unregistered terminal exit")
    terminalPids.delete(session.pid)
    const registered = (await request("/workspaces")).workspaces
    assert.equal(registered.some(item => item.id === workspace.id), false)
    assert.equal(registered.some(item => item.id === other.id), true)
  })

  await t.test("runtime shutdown allows stop escalation before exiting", { skip: process.platform === "win32" }, async () => {
    await register(workspaceRoot)
    const { session } = await runScript("shutdown-term.cjs", `
      process.on("SIGTERM", () => {})
      setInterval(() => {}, 1000)
      process.stdout.write("READY\\n")
    `, "exec ")
    await waitFor(async () => (await poll(session.id)).session.output.includes("READY"), "shutdown fixture setup")
    const closed = once(child, "close")
    child.kill("SIGTERM")
    const [code] = await closed
    assert.equal(code, 0)
    assert.throws(() => process.kill(session.pid, 0), { code: "ESRCH" })
    terminalPids.delete(session.pid)
  })
})
