import test from 'node:test'
import assert from 'node:assert/strict'
import { workspaceRuntime } from '../src/lib/workspaceRuntime.js'

const originalFetch = globalThis.fetch
const originalWindow = globalThis.window
const calls = []
const makeResponse = body => ({ ok: true, json: async () => body })
let token = 'test-token'

test.beforeEach(() => {
  calls.length = 0
  token = 'test-token'
  globalThis.window = { setTimeout, clearTimeout, sessionStorage: {
    getItem: () => token,
    setItem: (_key, value) => { token = value },
    removeItem: () => { token = '' }
  } }
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return makeResponse({ session: { id: 'session-a' }, sessions: [] })
  }
})
test.after(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow })

test('PTY transport scopes and encodes every endpoint and retains auth headers', async () => {
  await workspaceRuntime.listPty('work/a')
  await workspaceRuntime.createPty('work/a', { cols: 100, rows: 30, clientId: 'new-1' })
  await workspaceRuntime.pollPty('work/a', 'session/a', 42)
  await workspaceRuntime.writePty('work/a', 'session/a', '\u0003')
  await workspaceRuntime.resizePty('work/a', 'session/a', 132, 45)
  await workspaceRuntime.closePty('work/a', 'session/a')
  assert.equal(calls.length, 6)
  for (const { url, options } of calls) {
    assert.match(url, /\/workspaces\/work%2Fa\/terminal\/pty/)
    assert.equal(options.headers['X-AI-Memory-Workspace-Token'], 'test-token')
    assert.ok(options.signal instanceof AbortSignal)
  }
  assert.match(calls[2].url, /\/session%2Fa\?cursor=42&waitMs=20000$/)
  assert.equal(calls[3].options.body, JSON.stringify({ data: '\u0003' }))
  assert.equal(calls[4].options.body, JSON.stringify({ cols: 132, rows: 45 }))
  assert.equal(calls[5].options.method, 'DELETE')
  assert.equal(JSON.parse(calls[1].options.body).clientId, 'new-1')
})

test('PTY calls fail closed without an explicit workspace', async () => {
  await assert.rejects(workspaceRuntime.createPty('', {}), /indisponível/)
  await assert.rejects(workspaceRuntime.writePty('', 's', 'echo test\r'), /indisponível/)
  assert.equal(calls.length, 0)
})

test('long-poll abort reaches fetch and is never retried', async () => {
  const external = new AbortController()
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))
  }
  const poll = workspaceRuntime.pollPty('one', 'two', 0, { signal: external.signal })
  external.abort()
  await assert.rejects(poll, { name: 'AbortError' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.signal.aborted, true)
})

test('an uncertain stdin write is not replayed', async () => {
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    throw new TypeError('network disconnected after sending')
  }
  await assert.rejects(workspaceRuntime.writePty('one', 'two', 'echo once\r'), /disconnected/)
  assert.equal(calls.length, 1)
})

test('a confirmed 401 re-pairs once and retries only the rejected request', async () => {
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    if (calls.length === 1) return { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) }
    if (url.endsWith('/pair')) return makeResponse({ token: 'fresh-test-token' })
    return makeResponse({ sessions: [] })
  }
  assert.deepEqual(await workspaceRuntime.listPty('scope'), { sessions: [] })
  assert.equal(calls.length, 3)
  assert.equal(calls[0].url, calls[2].url)
  assert.equal(calls[2].options.headers['X-AI-Memory-Workspace-Token'], 'fresh-test-token')
})
