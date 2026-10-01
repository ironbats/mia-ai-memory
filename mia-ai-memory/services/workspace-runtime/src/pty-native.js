import { spawnSync } from "node:child_process"

// PTY job control gives foreground jobs their own process group. Snapshot the
// descendants before closing the shell so ordinary jobs cannot become orphans.
// Deliberately daemonized/reparented jobs still need OS-level containment.
export const terminatePty = child => {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 2000 })
    if (result.error || result.status !== 0) child.kill()
    return
  }
  const result = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", timeout: 1000, maxBuffer: 4 * 1024 * 1024 })
  const children = new Map()
  if (result.status === 0) {
    for (const line of result.stdout.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/)
      if (!match) continue
      const pid = Number(match[1])
      const parent = Number(match[2])
      if (!children.has(parent)) children.set(parent, [])
      children.get(parent).push(pid)
    }
  }
  const descendants = []
  const seen = new Set([child.pid])
  const pending = [child.pid]
  while (pending.length) {
    for (const pid of children.get(pending.pop()) || []) {
      if (seen.has(pid)) continue
      seen.add(pid)
      descendants.push(pid)
      pending.push(pid)
    }
  }
  for (const pid of descendants.reverse()) {
    try { process.kill(pid, "SIGKILL") } catch {
    }
  }
  try { process.kill(-child.pid, "SIGKILL") } catch {
  }
  child.kill("SIGKILL")
}
