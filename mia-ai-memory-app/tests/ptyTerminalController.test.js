import test from 'node:test'
import assert from 'node:assert/strict'
import { createPtyTerminalController, MAX_PTY_INPUT, MAX_PTY_TABS } from '../src/lib/ptyTerminalController.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const session = (id, extra = {}) => ({ id, running: true, shell: '/bin/bash', cwd: '/project', output: '', nextCursor: 0, cols: 80, rows: 24, ...extra })
function setup(overrides = {}) {
  const tasks = new Map(); let next = 0
  const calls = { creates: [], writes: [], closes: [], polls: [], resizes: [] }
  const adapter = {
    list: async () => ({ sessions: [] }),
    create: async options => { calls.creates.push(options); return { session: session(`shell-${calls.creates.length}`) } },
    poll: async (id, cursor, options) => { calls.polls.push({ id, cursor, options }); return { session: session(id) } },
    write: async (id, data) => { calls.writes.push({ id, data }) },
    resize: async (id, cols, rows) => { calls.resizes.push({ id, cols, rows }) },
    close: async id => { calls.closes.push(id); return { stopped: true, removed: true } },
    ...overrides
  }
  const controller = createPtyTerminalController(adapter, { schedule: (fn, ms) => { const key = ++next; tasks.set(key, { fn, ms }); return key }, cancel: id => tasks.delete(id) })
  const runNext = async () => { const [id, task] = tasks.entries().next().value || []; if (!task) throw new Error('No scheduled task'); tasks.delete(id); await task.fn(); await tick(); return task.ms }
  return { controller, calls, tasks, runNext, start: async () => { controller.attach(); controller.setEnabled(true); await tick(); return controller.getSnapshot().activeId } }
}

test('hidden/unready never starts a shell; StrictMode attaches once; hiding preserves it', async () => {
  const { controller, calls, start } = setup()
  controller.attach(); controller.setEnabled(false); await tick()
  assert.equal(calls.creates.length, 0)
  const id = await start()
  controller.detach(); controller.attach(); controller.setEnabled(true); await tick()
  assert.equal(calls.creates.length, 1)
  controller.setEnabled(false)
  assert.equal(controller.write(id, 'unsafe'), false)
  assert.equal(calls.closes.length, 0)
  controller.detach()
})

test('list finishes while hidden: start only after the panel is shown again', async () => {
  const listing = deferred()
  const { controller, calls } = setup({ list: () => listing.promise })
  controller.attach(); controller.setEnabled(true); controller.setEnabled(false)
  listing.resolve({ sessions: [] }); await tick()
  assert.equal(calls.creates.length, 0)
  controller.setEnabled(true); await tick()
  assert.equal(calls.creates.length, 1)
  controller.detach()
})

test('remount restores runtime sessions before creating; independent cursors and output', async () => {
  const { controller, calls, start, runNext } = setup({ list: async () => ({ sessions: [session('existing-a'), session('existing-b')] }), poll: async (id, cursor) => ({ session: session(id, { output: `${id}:${cursor}`, nextCursor: cursor + 10 }) }) })
  await start()
  assert.equal(calls.creates.length, 0)
  const a = []; const b = []
  controller.onOutput('existing-a', data => a.push(data)); controller.onOutput('existing-b', data => b.push(data))
  await runNext(); await runNext()
  assert.deepEqual(a, ['existing-a:0']); assert.deepEqual(b, ['existing-b:0'])
  controller.detach(); assert.equal(calls.closes.length, 0)
})

test('late create remains recoverable after unmount and StrictMode replay does not kill it', async () => {
  for (const replay of [false, true]) {
    const creation = deferred(); const closed = []
    const { controller } = setup({ create: () => creation.promise, close: async id => closed.push(id) })
    controller.attach(); controller.setEnabled(true); await tick(); controller.detach()
    if (replay) controller.attach()
    creation.resolve({ session: session('late-shell') }); await tick()
    assert.deepEqual(closed, [])
    if (replay) assert.equal(controller.getSnapshot().tabs[0].sessionId, 'late-shell')
    controller.detach()
  }
})

test('stdin is ordered and bounded; uncertain input is discarded, never retried', async () => {
  const first = deferred(); const writes = []
  const { controller, start } = setup({ write: async (id, data) => { writes.push(data); if (writes.length === 1) return first.promise } })
  const id = await start()
  assert.equal(controller.write(id, 'a'), true)
  assert.equal(controller.write(id, 'b'), true)
  assert.deepEqual(writes, ['a'])
  assert.equal(controller.write(id, 'x'.repeat(MAX_PTY_INPUT)), false)
  first.resolve(); await tick()
  assert.deepEqual(writes, ['a', 'b'])
  controller.detach()
  const pending = deferred(); const failures = []
  const second = setup({ write: async (id, data) => { failures.push(data); return pending.promise } })
  const secondId = await second.start()
  second.controller.write(secondId, 'first'); second.controller.write(secondId, 'must not replay')
  pending.reject(new Error('timeout')); await tick()
  assert.deepEqual(failures, ['first'])
  assert.match(second.controller.getSnapshot().tabs[0].error, /Nada foi reenviado/)
  second.controller.detach()
})

test('Unicode input survives request chunk boundaries', async () => {
  const { controller, calls, start } = setup()
  const id = await start(); const input = 'a'.repeat(4095) + '😀ação'.repeat(1200)
  controller.write(id, input); await tick()
  assert.equal(calls.writes.map(call => call.data).join(''), input)
  assert.ok(calls.writes.every(call => !/[\uD800-\uDBFF]$/.test(call.data)))
  controller.detach()
})

test('internal transport AbortError reconnects with backoff; detach aborts its own poll', async () => {
  let attempts = 0
  const { controller, start, runNext, tasks } = setup({ poll: async () => { attempts++; const error = new Error('timeout'); error.name = 'AbortError'; throw error } })
  await start(); await runNext()
  assert.equal(attempts, 1)
  assert.equal(controller.getSnapshot().tabs[0].status, 'Reconectando…')
  assert.equal([...tasks.values()][0].ms, 500)
  await runNext(); assert.equal([...tasks.values()][0].ms, 1000)
  controller.reconnect(); assert.equal([...tasks.values()][0].ms, 0)
  controller.detach(); assert.equal(tasks.size, 0)
})

test('missing session stops polling and restart opens a new shell; tab cap holds', async () => {
  const { controller, start, runNext, tasks, calls } = setup({ poll: async () => { throw Object.assign(new Error('gone'), { status: 404 }) }, close: async () => { throw Object.assign(new Error('gone'), { status: 404 }) } })
  const id = await start(); await runNext()
  assert.equal(controller.getSnapshot().tabs[0].running, false); assert.equal(tasks.size, 0)
  await controller.restart(id)
  assert.equal(calls.creates.length, 2); assert.equal(controller.getSnapshot().tabs.length, 1)
  for (let index = 0; index < MAX_PTY_TABS + 2; index++) await controller.create()
  assert.equal(controller.getSnapshot().tabs.length, MAX_PTY_TABS)
  controller.detach()
})

test('close failure preserves shell; resize coalesces to latest geometry', async () => {
  const pending = deferred(); const sizes = []
  const { controller, start } = setup({ close: async () => { throw new Error('network') }, resize: async (id, cols, rows) => { sizes.push([cols, rows]); if (sizes.length === 1) return pending.promise } })
  const id = await start()
  const resizing = controller.resize(id, 100, 30)
  controller.resize(id, 120, 40); controller.resize(id, 140, 50)
  assert.deepEqual(sizes, [[100, 30]])
  pending.resolve(); await resizing
  assert.deepEqual(sizes, [[100, 30], [140, 50]])
  assert.equal(await controller.close(id), false)
  assert.equal(controller.getSnapshot().tabs.length, 1)
  assert.match(controller.getSnapshot().tabs[0].error, /Não foi possível encerrar/)
  controller.detach()
})

test('a replacement controller can adopt a creation before the original response arrives', async () => {
  const creation = deferred(); const closed = []
  const old = setup({ create: () => creation.promise, close: async id => closed.push(id) })
  old.controller.attach(); old.controller.setEnabled(true); await tick(); old.controller.detach()
  const replacement = setup({ list: async () => ({ sessions: [session('adopted')] }) })
  await replacement.start()
  creation.resolve({ session: session('adopted') }); await tick()
  assert.deepEqual(closed, [])
  assert.equal(replacement.controller.getSnapshot().tabs[0].sessionId, 'adopted')
  replacement.controller.detach()
})

test('historical runtime prefix is replay-tagged and polling awaits renderer backpressure', async () => {
  const parsed = deferred(); const chunks = []
  const { controller, start, runNext, tasks } = setup({ list: async () => ({ sessions: [session('restored', { nextCursor: 3 })] }), poll: async () => ({ session: session('restored', { output: 'oldNEW', nextCursor: 6 }) }) })
  await start()
  controller.onOutput('restored', (data, options) => { chunks.push({ data, ...options }); if (data === 'old') return parsed.promise })
  const polling = runNext(); await tick()
  assert.deepEqual(chunks, [{ data: 'old', replay: true }, { data: 'NEW', replay: false }])
  assert.equal(tasks.size, 0, 'no next poll until the async renderer finishes')
  parsed.resolve(); await polling
  assert.deepEqual(chunks, [{ data: 'old', replay: true }, { data: 'NEW', replay: false }])
  assert.equal(tasks.size, 1)
  const replay = []
  controller.onOutput('restored', (data, options) => replay.push({ data, ...options }))
  assert.equal(replay.map(part => part.data).join(''), 'oldNEW')
  assert.ok(replay.every(part => part.replay))
  controller.detach()
})


test('reconnect waits for pending parse and does not request an already-enqueued cursor', async () => {
  const parsed = deferred(); const cursors = []; const chunks = []
  const { controller, start, runNext } = setup({ poll: async (id, cursor) => { cursors.push(cursor); return { session: session(id, { output: cursor === 0 ? 'once' : '', nextCursor: 4 }) } } })
  const id = await start()
  controller.onOutput(id, data => { chunks.push(data); return parsed.promise })
  const firstPoll = runNext(); await tick()
  controller.reconnect()
  const reconnected = runNext(); await tick()
  assert.deepEqual(cursors, [0])
  parsed.resolve(); await firstPoll; await reconnected
  assert.deepEqual(cursors, [0, 4])
  assert.deepEqual(chunks, ['once'])
  controller.detach()
})


test('fresh output before renderer mount remains live; initial protocol replies have session identity', async () => {
  const { controller, calls, start } = setup({ create: async () => ({ session: session('fresh', { output: '\x1b[6n', nextCursor: 4 }) }) })
  const id = await start(); const chunks = []
  controller.onOutput(id, (data, options) => { chunks.push({ data, ...options }); if (!options.replay) controller.write(id, '\x1b[1;1R', { protocol: true }) })
  await tick()
  assert.deepEqual(chunks, [{ data: '\x1b[6n', replay: false }])
  assert.deepEqual(calls.writes, [{ id: 'fresh', data: '\x1b[1;1R' }])
  const replay = []
  controller.onOutput(id, (data, options) => replay.push({ data, ...options }))
  assert.deepEqual(replay, [{ data: '\x1b[6n', replay: true }])
  controller.detach()
})
