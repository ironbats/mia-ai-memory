import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { appendTerminalOutput, createTerminalOutput, readTerminalOutput } from "./terminal-output.js"

export const PTY_INPUT_MAX_BYTES = 64 * 1024
export const PTY_JSON_MAX_BYTES = PTY_INPUT_MAX_BYTES * 6 + 1024
export const PTY_OUTPUT_MAX_BYTES = 1024 * 1024
export const PTY_POLL_MAX_MS = 20000

const failure = (message, status, code) => Object.assign(new Error(message), { status, code, expose: true })
const notFound = () => failure("terminal session not found", 404, "TERMINAL_NOT_FOUND")

export const terminalDimensions = (cols = 80, rows = 24) => {
  if (!Number.isInteger(cols) || cols < 2 || cols > 500 || !Number.isInteger(rows) || rows < 1 || rows > 300) {
    throw failure("terminal dimensions must be integers (cols 2–500, rows 1–300)", 400, "INVALID_TERMINAL_SIZE")
  }
  return { cols, rows }
}

export const terminalCursor = (value = 0) => {
  const cursor = Number(value)
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw failure("invalid terminal cursor", 400, "INVALID_TERMINAL_CURSOR")
  return cursor
}

export const defaultShell = (platform = process.platform, env = process.env) => {
  const candidates = platform === "win32"
    ? [path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "cmd.exe")]
    : platform === "darwin" ? ["/bin/zsh", "/bin/bash", "/bin/sh"] : ["/bin/bash", "/bin/sh"]
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK)
      return { file: candidate, args: platform === "win32" ? (candidate.endsWith("cmd.exe") ? ["/Q"] : ["-NoLogo"]) : ["-i"] }
    } catch {
    }
  }
  throw failure("no supported interactive shell is installed", 503, "PTY_UNAVAILABLE")
}

// Each PTY is a host shell with the runtime user's permissions, not a sandbox.
export const createPtyManager = ({
  spawnPty,
  shell = defaultShell(),
  env = process.env,
  now = Date.now,
  maxPerWorkspace = 8,
  maxSessions = 64,
  maxOutputBytes = PTY_OUTPUT_MAX_BYTES,
  detachedTtlMs = 30 * 60 * 1000,
  exitedTtlMs = 5 * 60 * 1000,
  sweepMs = 30000,
  maxWaitersPerSession = 8,
  terminate = child => child.kill()
} = {}) => {
  const sessions = new Map()
  const closing = new Set()
  let disposed = false

  const touch = session => { session.lastSeen = now() }
  const find = (workspaceId, id) => {
    const session = sessions.get(id)
    if (!session || session.workspaceId !== workspaceId) throw notFound()
    touch(session)
    return session
  }
  const payload = (session, cursor = 0) => ({
    id: session.id,
    workspaceId: session.workspaceId,
    clientId: session.clientId,
    shell: session.shell,
    cwd: session.cwd,
    cols: session.cols,
    rows: session.rows,
    running: session.running,
    exitCode: session.exitCode,
    signal: session.signal,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    pid: session.pid,
    removed: session.removed,
    ...readTerminalOutput(session, cursor)
  })
  const wake = session => {
    for (const finish of [...session.waiters]) finish()
  }
  const release = session => {
    for (const disposable of session.subscriptions) disposable.dispose()
    session.subscriptions = []
    closing.delete(session)
    session.child = null
  }
  const destroy = session => {
    if (session.child && session.running) {
      // Keep closing processes in the admission count until their exit callback.
      closing.add(session)
      try {
        terminate(session.child)
      } catch (error) {
        closing.delete(session)
        throw failure("could not close terminal", 409, "TERMINAL_STOP_FAILED")
      }
    }
    session.running = false
    session.removed = true
    session.endedAt ||= new Date(now()).toISOString()
    sessions.delete(session.id)
    wake(session)
    if (!session.child) release(session)
  }
  const sweep = () => {
    for (const session of sessions.values()) {
      const stale = session.running
        ? now() - session.lastSeen >= detachedTtlMs && session.waiters.size === 0
        : now() - session.exitedAt >= exitedTtlMs
      if (stale) {
        // A failed stop remains tracked and will be retried on the next sweep.
        try { destroy(session) } catch {
        }
      }
    }
  }
  const sweeper = sweepMs > 0 ? setInterval(sweep, sweepMs) : null
  sweeper?.unref()

  return {
    create(workspace, options = {}) {
      if (disposed) throw failure("terminal runtime is shutting down", 503, "PTY_UNAVAILABLE")
      if (typeof spawnPty !== "function") throw failure("native PTY module is unavailable; reinstall runtime dependencies", 503, "PTY_UNAVAILABLE")
      const { cols, rows } = terminalDimensions(options.cols, options.rows)
      const clientId = options.clientId ?? null
      if (clientId !== null && (typeof clientId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(clientId))) {
        throw failure("invalid terminal clientId", 400, "INVALID_TERMINAL_CLIENT_ID")
      }
      sweep()
      if (clientId) {
        const existing = [...sessions.values()].find(session => session.workspaceId === workspace.id && session.clientId === clientId)
        if (existing) {
          touch(existing)
          return { session: payload(existing), created: false }
        }
      }
      const occupied = new Set([...sessions.values(), ...closing])
      if (occupied.size >= maxSessions || [...occupied].filter(session => session.workspaceId === workspace.id).length >= maxPerWorkspace) {
        throw failure("terminal session limit reached; close a terminal first", 429, "TERMINAL_LIMIT")
      }
      let child
      try {
        child = spawnPty(shell.file, [...shell.args], {
          name: "xterm-256color", cols, rows, cwd: workspace.root,
          env: { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" },
          encoding: "utf8"
        })
      } catch {
        throw failure("interactive shell could not start; check the native PTY installation", 503, "PTY_UNAVAILABLE")
      }
      const session = {
        id: crypto.randomUUID(), workspaceId: workspace.id, clientId,
        shell: shell.file, cwd: workspace.root, cols, rows,
        running: true, exitCode: null, signal: null,
        startedAt: new Date(now()).toISOString(), endedAt: null, exitedAt: null,
        pid: child.pid || null, child, lastSeen: now(), removed: false,
        ...createTerminalOutput(), waiters: new Set(), subscriptions: []
      }
      sessions.set(session.id, session)
      session.subscriptions.push(child.onData(data => {
        appendTerminalOutput(session, data, maxOutputBytes)
        wake(session)
      }))
      session.subscriptions.push(child.onExit(event => {
        session.running = false
        session.exitCode = Number.isInteger(event.exitCode) ? event.exitCode : null
        session.signal = event.signal || null
        session.endedAt = new Date(now()).toISOString()
        session.exitedAt = now()
        release(session)
        wake(session)
      }))
      return { session: payload(session), created: true }
    },
    list(workspaceId) {
      sweep()
      // The poll endpoint owns output delivery; listing never replays scrollback.
      return [...sessions.values()].filter(session => session.workspaceId === workspaceId)
        .map(session => payload(session, session.outputOffset + session.output.length))
    },
    async read(workspaceId, id, cursor = 0, { signal, waitMs = PTY_POLL_MAX_MS } = {}) {
      cursor = terminalCursor(cursor)
      const session = find(workspaceId, id)
      const snapshot = payload(session, cursor)
      if (signal?.aborted) throw signal.reason || new DOMException("Request aborted", "AbortError")
      if (!session.running || snapshot.output || snapshot.truncated || cursor !== snapshot.nextCursor || waitMs <= 0) return snapshot
      if (session.waiters.size >= maxWaitersPerSession) throw failure("too many terminal readers", 429, "TERMINAL_READER_LIMIT")
      await new Promise((resolve, reject) => {
        let timer
        const cleanup = () => {
          clearTimeout(timer)
          session.waiters.delete(finish)
          signal?.removeEventListener("abort", abort)
        }
        const finish = () => { cleanup(); resolve() }
        const abort = () => { cleanup(); reject(signal.reason || new DOMException("Request aborted", "AbortError")) }
        session.waiters.add(finish)
        signal?.addEventListener("abort", abort, { once: true })
        timer = setTimeout(finish, Math.min(PTY_POLL_MAX_MS, Math.max(0, waitMs)))
        timer.unref()
      })
      touch(session)
      return payload(session, cursor)
    },
    input(workspaceId, id, data) {
      const session = find(workspaceId, id)
      if (typeof data !== "string") throw failure("terminal input must be a string", 400, "INVALID_TERMINAL_INPUT")
      if (Buffer.byteLength(data, "utf8") > PTY_INPUT_MAX_BYTES) throw failure("terminal input too large", 413, "BODY_TOO_LARGE")
      if (!session.running || !session.child) throw failure("terminal has exited", 409, "TERMINAL_EXITED")
      try { session.child.write(data) } catch { throw failure("terminal input failed", 409, "TERMINAL_INPUT_FAILED") }
      return payload(session, session.outputOffset + session.output.length)
    },
    resize(workspaceId, id, cols, rows) {
      const session = find(workspaceId, id)
      if (cols === undefined || rows === undefined) throw failure("terminal dimensions required", 400, "INVALID_TERMINAL_SIZE")
      terminalDimensions(cols, rows)
      if (!session.running || !session.child) throw failure("terminal has exited", 409, "TERMINAL_EXITED")
      try { session.child.resize(cols, rows) } catch { throw failure("terminal resize failed", 409, "TERMINAL_RESIZE_FAILED") }
      session.cols = cols
      session.rows = rows
      wake(session)
      return payload(session, session.outputOffset + session.output.length)
    },
    remove(workspaceId, id) {
      destroy(find(workspaceId, id))
      return { stopped: true, removed: true }
    },
    removeWorkspace(workspaceId) {
      for (const session of sessions.values()) if (session.workspaceId === workspaceId) destroy(session)
    },
    dispose() {
      disposed = true
      clearInterval(sweeper)
      for (const session of sessions.values()) destroy(session)
    },
    sweep
  }
}
