import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertNodeVersion, dependencyProblems, ensureDependencies } from '../script/ensure-dependencies.mjs'

const put = (root, path, contents) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), typeof contents === 'string' ? contents : JSON.stringify(contents)) }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ai-memory-deps-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dependencies = { '@xterm/xterm': '6.0.0', '@xterm/addon-fit': '0.11.0', '@xterm/addon-search': '0.16.0' }
  const devDependencies = { vite: '8.2.2' }
  const manifest = { name: 'bootstrap-test', dependencies, devDependencies }
  const lock = { lockfileVersion: 3, packages: { '': manifest } }
  for (const [name, version] of Object.entries({ ...dependencies, ...devDependencies, transitive: '1.2.3' })) {
    lock.packages[`node_modules/${name}`] = { version }
  }
  lock.packages['node_modules/other-platform-binding'] = { version: '1.0.0', optional: true, os: ['unsupported-test-platform'] }
  put(root, 'package.json', manifest); put(root, 'package-lock.json', lock)
  const install = () => {
    for (const [path, expected] of Object.entries(lock.packages)) {
      if (!path || expected.optional) continue
      put(root, `${path}/package.json`, { name: path.replace('node_modules/', ''), version: expected.version, main: 'index.js' })
      put(root, `${path}/index.js`, 'module.exports = {}')
    }
    put(root, 'node_modules/vite/bin/vite.js', '')
    put(root, 'node_modules/@xterm/xterm/css/xterm.css', '')
  }
  return { root, manifest, lock, install }
}

test('fresh tree installs once, then healthy startup is offline and makes no install call', t => {
  const f = fixture(t); let calls = 0
  assert.deepEqual(ensureDependencies({ probe: () => [], root: f.root, log: () => {}, install: () => { calls++; f.install() } }), { installed: true })
  assert.deepEqual(ensureDependencies({ probe: () => [], root: f.root, install: () => assert.fail('must not install again') }), { installed: false })
  assert.equal(calls, 1)
})

test('existing Vite with missing xterm triggers repair (reported regression)', t => {
  const f = fixture(t); f.install(); rmSync(join(f.root, 'node_modules/@xterm'), { recursive: true })
  assert.match(dependencyProblems(f.root).join('\n'), /@xterm\/xterm/)
  assert.deepEqual(ensureDependencies({ probe: () => [], root: f.root, install: f.install, log: () => {} }), { installed: true })
  assert.deepEqual(dependencyProblems(f.root), [])
})

test('installed versions must match the lock including transitive dependencies', t => {
  const f = fixture(t); f.install()
  put(f.root, 'node_modules/transitive/package.json', { version: '0.0.1' })
  assert.match(dependencyProblems(f.root).join('\n'), /transitive: esperado 1.2.3, encontrado 0.0.1/)
})

test('a changed transitive lock version invalidates the installed tree', t => {
  const f = fixture(t); f.install(); f.lock.packages['node_modules/transitive'].version = '2.0.0'
  put(f.root, 'package-lock.json', f.lock)
  assert.match(dependencyProblems(f.root).join('\n'), /esperado 2.0.0/)
})

test('package metadata alone is insufficient: missing entry and CSS are detected', t => {
  const f = fixture(t); f.install(); assert.deepEqual(dependencyProblems(f.root), [])
  rmSync(join(f.root, 'node_modules/@xterm/xterm/index.js'))
  rmSync(join(f.root, 'node_modules/@xterm/xterm/css/xterm.css'))
  assert.match(dependencyProblems(f.root).join('\n'), /entrada não resolvida/)
  assert.match(dependencyProblems(f.root).join('\n'), /xterm.css: ausente/)
})

test('missing platform-specific optional packages do not cause endless reinstalls', t => {
  const f = fixture(t); f.install(); assert.deepEqual(dependencyProblems(f.root), [])
})

test('manifest-lock divergence fails before installation and does not mutate files', t => {
  const f = fixture(t); f.manifest.dependencies['@xterm/xterm'] = '7.0.0'; put(f.root, 'package.json', f.manifest)
  const before = readFileSync(join(f.root, 'package-lock.json'), 'utf8')
  assert.throws(() => ensureDependencies({ probe: () => [], root: f.root, install: () => assert.fail('must not install') }), /divergentes/)
  assert.equal(readFileSync(join(f.root, 'package-lock.json'), 'utf8'), before)
})

test('missing lock fails with recovery guidance without generating new versions', t => {
  const f = fixture(t); rmSync(join(f.root, 'package-lock.json'))
  assert.throws(() => ensureDependencies({ probe: () => [], root: f.root, install: () => assert.fail('must not install') }), /Restaure o lockfile/)
})

test('check-only reports repair command without installing', t => {
  const f = fixture(t)
  assert.throws(() => ensureDependencies({ probe: () => [], root: f.root, checkOnly: true, install: () => assert.fail('must not install') }), /npm run deps:ensure/)
})

test('failed installation is propagated and never treated as a ready frontend', t => {
  const f = fixture(t)
  assert.throws(() => ensureDependencies({ probe: () => [], root: f.root, log: () => {}, install: () => { throw new Error('offline install failed') } }), /offline install failed/)
})

test('successful npm exit still requires a second dependency validation', t => {
  const f = fixture(t)
  assert.throws(() => ensureDependencies({ probe: () => [], root: f.root, log: () => {}, install: () => {} }), /verificação ainda falhou/)
})

test('bootstrap checks dependencies relative to the project instead of process cwd', t => {
  const f = fixture(t); f.install(); assert.notEqual(process.cwd(), f.root)
  assert.deepEqual(dependencyProblems(f.root), [])
})

test('Node compatibility matches locked Vite and jsdom versions', () => {
  for (const v of ['20.19.0', '22.0.0', '22.11.9', '23.11.0']) assert.throws(() => assertNodeVersion(v), /incompatível/)
  for (const v of ['22.12.0', '22.22.0', '24.0.0', '24.19.0', '26.0.0']) assert.doesNotThrow(() => assertNodeVersion(v))
})


test('missing native tooling triggers one repair and is rechecked', t => {
  const f = fixture(t); f.install(); let repaired = false
  assert.deepEqual(ensureDependencies({ root: f.root, log: () => {}, probe: () => repaired ? [] : ['native binding missing'], install: () => { repaired = true } }), { installed: true })
})

test('a native toolchain that stays broken fails closed after one install', t => {
  const f = fixture(t); f.install(); let installs = 0
  assert.throws(() => ensureDependencies({ root: f.root, log: () => {}, probe: () => ['native binding missing'], install: () => { installs++ } }), /verificação ainda falhou/)
  assert.equal(installs, 1)
})
