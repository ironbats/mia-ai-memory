import test from 'node:test'
import assert from 'node:assert/strict'
import { createTerminalController, navigateHistory, appendOutput, MAX_TERMINAL_TABS } from '../src/lib/terminalController.js'

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const harness = () => {
  const queue = new Map(); let tick = 0
  const controller = createTerminalController({ schedule: callback => { queue.set(++tick, callback); return tick }, cancel: id => queue.delete(id) })
  return { controller, queue, next: async () => { const [id, fn] = queue.entries().next().value; queue.delete(id); await fn() } }
}
const active = controller => controller.getSnapshot().tabs.find(tab => tab.id === controller.getSnapshot().activeId)
const output = tab => tab.entries.map(entry => entry.text).join('')
const start = (controller, adapter, command = 'echo hello') => { const id = active(controller).id; controller.input(id, command); return controller.run(id, adapter) }
const session = (id, output = '', running = true, nextCursor = output.length) => ({ session: { id, running, output, nextCursor, exitCode: running ? null : 0 } })

test('history preserves unfinished input after up/down navigation', () => {
  const up = navigateHistory(['one', 'two'], -1, '', 'draft text', -1)
  assert.deepEqual(up, { index: 1, draft: 'draft text', value: 'two' })
  assert.deepEqual(navigateHistory(['one', 'two'], up.index, up.draft, up.value, 1), { index: -1, draft: 'draft text', value: 'draft text' })
})
test('double submit cannot start two commands, clear does not execute', async () => {
  const { controller } = harness(); const request = deferred(); let calls = 0
  const adapter = { execute: () => { calls++; return request.promise } }
  const run = start(controller, adapter)
  controller.input(active(controller).id, 'second')
  await controller.run(active(controller).id, adapter)
  assert.equal(calls, 1)
  request.resolve(session('one', 'done', false)); await run
  await start(controller, adapter, 'clear')
  assert.equal(calls, 1); assert.equal(active(controller).entries.length, 0)
})
test('project change during POST keeps late response in original controller', async () => {
  const projectA = harness(); const projectB = harness(); const request = deferred()
  const run = start(projectA.controller, { execute: () => request.promise, poll: async () => session('a', '', false) })
  request.resolve(session('a', 'private project A')); await run
  assert.match(output(active(projectA.controller)), /private project A/)
  assert.equal(output(active(projectB.controller)), '')
})
test('concurrent tab creation while polling cannot drop jobs or mix their output', async () => {
  const { controller, next, queue } = harness(); const poll = deferred()
  await start(controller, { execute: async () => session('a'), poll: () => poll.promise })
  const firstId = active(controller).id; const ticking = next()
  controller.create()
  await start(controller, { execute: async () => session('b'), poll: async () => session('b', 'B', false) })
  poll.resolve(session('a', 'A', false)); await ticking; await next()
  const tabs = controller.getSnapshot().tabs
  assert.match(output(tabs.find(tab => tab.id === firstId)), /A/)
  assert.match(output(active(controller)), /B/)
  assert.equal(tabs.every(tab => !tab.busy), true); assert.equal(queue.size, 0)
})
test('transient poll failures retry same cursor; 404 releases the terminal', async () => {
  const { controller, next, queue } = harness(); const cursors = []; let calls = 0
  await start(controller, { execute: async () => session('a', 'first', true, 5), poll: async (_, cursor) => {
    cursors.push(cursor)
    if (++calls === 1) throw new Error('network')
    if (calls === 2) return session('a', 'second', true, 11)
    throw Object.assign(new Error('gone'), { status: 404 })
  } })
  await next(); assert.equal(active(controller).status, 'Reconectando…')
  await next(); await next()
  assert.deepEqual(cursors, [5, 5, 11]); assert.equal(active(controller).busy, false); assert.equal(queue.size, 0)
})
test('closing running tab is blocked, stopping uses its captured project adapter', async () => {
  const { controller, next } = harness(); const stopped = []
  await start(controller, { execute: async () => session('scoped-session'), poll: async () => session('scoped-session', '', false), stop: async id => { stopped.push(id); return true } })
  const id = active(controller).id
  assert.equal(controller.close(id), false)
  await controller.stop(id); await controller.stop(id)
  assert.deepEqual(stopped, ['scoped-session'])
  await next(); assert.equal(controller.close(id), true); assert.equal(controller.getSnapshot().tabs.length, 1)
})
test('unsubscribe/re-subscribe (hidden panel) preserves output and live job', async () => {
  const { controller, next } = harness()
  const unsubscribe = controller.subscribe(() => {})
  await start(controller, { execute: async () => session('a'), poll: async () => session('a', 'background output', false) })
  unsubscribe(); await next(); controller.subscribe(() => {})
  assert.match(output(active(controller)), /background output/)
})
test('disposed controller ignores late poll and execute responses', async () => {
  const a = harness(); const response = deferred()
  const run = start(a.controller, { execute: () => response.promise })
  a.controller.dispose(); const before = a.controller.getSnapshot()
  response.resolve(session('a', 'late')); await run
  assert.equal(a.controller.getSnapshot(), before); assert.equal(a.queue.size, 0)
  const b = harness(); const polling = deferred()
  await start(b.controller, { execute: async () => session('b'), poll: () => polling.promise })
  const tick = b.next(); b.controller.dispose(); const beforePoll = b.controller.getSnapshot()
  polling.resolve(session('b', 'late')); await tick
  assert.equal(b.controller.getSnapshot(), beforePoll); assert.equal(b.queue.size, 0)
})
test('stream chunks concatenate without inserted newlines and truncated output is identified', async () => {
  const { controller, next } = harness()
  await start(controller, { execute: async () => session('a', 'hel'), poll: async () => ({ session: { ...session('a', 'lo', false).session, truncated: true } }) })
  await next()
  assert.match(output(active(controller)), /buffer do runtime/)
  assert.equal(appendOutput([], [{ type: 'output', text: 'hel' }, { type: 'output', text: 'lo' }]).map(x => x.text).join(''), 'hello')
})
test('output and number of tabs are bounded', () => {
  const { controller } = harness()
  for (let n = 0; n < 100; n++) controller.create()
  assert.equal(controller.getSnapshot().tabs.length, MAX_TERMINAL_TABS)
  assert.ok(appendOutput([], [{ text: 'a'.repeat(300000) }]).reduce((sum, x) => sum + x.text.length, 0) <= 160000)
})
test('late stop response cannot overwrite status of the next command', async () => {
  const { controller, next } = harness(); const stopping = deferred()
  await start(controller, { execute: async () => session('first'), poll: async () => session('first', '', false), stop: () => stopping.promise })
  const stop = controller.stop(active(controller).id)
  await next()
  await start(controller, { execute: async () => session('second'), poll: async () => session('second') })
  stopping.resolve(true); await stop
  assert.equal(active(controller).status, 'Executando')
  assert.equal(active(controller).sessionId, 'second')
})
