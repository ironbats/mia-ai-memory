// Explicit opt-in real npm/Vite integration: npm run test:startup.
// Installs only in an isolated OS temporary directory; never edits this checkout.
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { projectRoot } from '../script/ensure-dependencies.mjs'

async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port
}
async function runFrontend(root, { shell = false, env = {}, expectRepair = false } = {}) {
  const port = await freePort()
  const args = shell ? [join(root, 'script/run-local.sh')] : [process.env.npm_execpath, 'run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort']
  assert.ok(shell || process.env.npm_execpath, 'Run this integration through npm run test:startup')
  const child = spawn(shell ? 'bash' : process.execPath, args, {
    cwd: shell ? tmpdir() : root, detached: process.platform !== 'win32',
    env: { ...process.env, ...env, FRONTEND_HOST: '127.0.0.1', FRONTEND_PORT: String(port), COGNITIVE_API_URL: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''; child.stdout.on('data', b => { output += b }); child.stderr.on('data', b => { output += b })
  let exited = false; child.once('exit', () => { exited = true })
  try {
    let ready = false
    for (let i = 0; i < 600; i++) {
      if (exited) assert.fail(`Frontend exited early:\n${output}`)
      try { const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }); if (r.ok) { ready = true; break } } catch {}
      await delay(100)
    }
    assert.ok(ready, `Frontend did not start:\n${output}`)
    const module = await fetch(`http://127.0.0.1:${port}/src/lib/xtermSurface.js`)
    const source = await module.text()
    assert.equal(module.status, 200, source)
    assert.doesNotMatch(source, /Failed to resolve import|vite-error-overlay/)
    assert.match(source, /@xterm_xterm|@xterm\/xterm/)
    const css = await fetch(`http://127.0.0.1:${port}/node_modules/@xterm/xterm/css/xterm.css`)
    assert.equal(css.status, 200)
    assert.match(await css.text(), /xterm/)
    assert.equal(/Sincronizando dependências/.test(output), expectRepair, output)
    return output
  } finally {
    const exit = new Promise(resolve => child.once('exit', resolve))
    if (!exited) {
      try { process.platform === 'win32' ? child.kill('SIGTERM') : process.kill(-child.pid, 'SIGTERM') } catch {}
      await Promise.race([exit, delay(3000)])
      if (!exited) { try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL') } catch {} }
    }
  }
}

test('real startup: fresh install, offline healthy tree, stale xterm and missing native binding', { timeout: 240000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'ai-memory-startup-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const name of ['package.json', 'package-lock.json', 'index.html', 'vite.config.js', 'script', 'src']) cpSync(join(projectRoot, name), join(root, name), { recursive: true })
  await t.test('npm run dev installs from nothing with NODE_ENV=production and dev/optional omission configured', async () => {
    const output = await runFrontend(root, { expectRepair: true, env: { NODE_ENV: 'production', npm_config_omit: 'dev\noptional' } })
    assert.match(output, /Dependências verificadas/)
  })
  await t.test('healthy npm run dev starts offline without reinstalling', async () => {
    await runFrontend(root, { env: { npm_config_offline: 'true' } })
  })
  await t.test('shell starts from another cwd and repairs missing xterm despite existing Vite', { skip: process.platform === 'win32' }, async () => {
    assert.ok(existsSync(join(root, 'node_modules/vite/bin/vite.js')))
    rmSync(join(root, 'node_modules/@xterm'), { recursive: true })
    await runFrontend(root, { shell: true, expectRepair: true })
  })
  await t.test('missing native optional bindings are repaired instead of passing a path-only check', async () => {
    const bindingRoot = join(root, 'node_modules/@rolldown')
    for (const name of readdirSync(bindingRoot)) if (name.startsWith('binding-')) rmSync(join(bindingRoot, name), { recursive: true })
    await runFrontend(root, { expectRepair: true, env: { npm_config_omit: 'optional' } })
  })
})
