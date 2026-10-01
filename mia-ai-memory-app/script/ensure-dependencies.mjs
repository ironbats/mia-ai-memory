import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = file => JSON.parse(readFileSync(file, 'utf8'))
const stableMap = value => JSON.stringify(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)))

export function assertNodeVersion(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number)
  if (!(major === 22 && minor >= 12 || major >= 24)) {
    throw new Error(`Node.js ${version} incompatível. Use Node.js 22.12+ (linha 22) ou 24+. As dependências travadas exigem essas versões.`)
  }
}

// Runs using Node built-ins only, including before the first npm install.
// Never infer dependency health from the existence of the Vite executable.
export function dependencyProblems(root = projectRoot) {
  const manifest = readJson(join(root, 'package.json'))
  const lockPath = join(root, 'package-lock.json')
  if (!existsSync(lockPath)) throw new Error('package-lock.json ausente. Restaure o lockfile da mesma entrega; a inicialização não cria ou altera versões automaticamente.')
  const lock = readJson(lockPath)
  if (!lock.packages?.['']) throw new Error('package-lock.json incompatível. É necessário um lockfile npm v2/v3 com packages.')
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    if (stableMap(manifest[section]) !== stableMap(lock.packages[''][section])) {
      throw new Error(`package.json e package-lock.json divergentes em ${section}. Aplique os dois arquivos da mesma entrega. Para uma alteração intencional, atualize o lock com npm install antes de iniciar.`)
    }
  }
  const problems = []
  for (const [path, expected] of Object.entries(lock.packages)) {
    if (!path) continue
    if (!path.startsWith('node_modules/') || path.split('/').includes('..')) throw new Error(`Caminho inesperado no lockfile: ${path}`)
    const installedPath = join(root, path, 'package.json')
    if (expected.optional && !existsSync(installedPath)) continue
    try {
      const actual = readJson(installedPath)
      if (actual.version !== expected.version) problems.push(`${path}: esperado ${expected.version}, encontrado ${actual.version}`)
    } catch { problems.push(`${path}: ausente ou incompleto`) }
  }
  // Validate resolution too: a leftover package.json is not a usable package.
  // Resolve in a fresh process: Node caches negative package lookups, and
  // reusing that cache after npm ci would falsely reject the repaired tree.
  const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
  const resolution = spawnSync(process.execPath, ['--input-type=commonjs', '-e', `
    const { statSync } = require('node:fs');
    const names = JSON.parse(process.argv[1]);
    const missing = names.filter(name => {
      try { return !statSync(require.resolve(name)).isFile() } catch { return true }
    });
    process.stdout.write(JSON.stringify(missing));
  `, JSON.stringify(names)], { cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024 })
  if (resolution.error || resolution.status !== 0) problems.push(`Não foi possível verificar imports: ${resolution.error?.message || resolution.stderr}`)
  else for (const name of JSON.parse(resolution.stdout)) problems.push(`${name}: entrada não resolvida`)
  for (const path of ['node_modules/vite/bin/vite.js', 'node_modules/@xterm/xterm/css/xterm.css']) {
    try { if (!statSync(join(root, path)).isFile()) throw new Error() }
    catch { problems.push(`${path}: ausente`) }
  }
  return [...new Set(problems)]
}

export function probeToolchain(root = projectRoot) {
  // Loading the tools also checks the native binding for this OS/CPU/libc.
  // Other platforms' optional bindings may legitimately be absent.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('vite'); await import('lightningcss')"], {
    cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024
  })
  return result.status === 0 && !result.error ? [] : [
    `Vite/Rolldown/Lightning CSS não carregam nesta plataforma: ${(result.error?.message || result.stderr || `saída ${result.status}`).trim().slice(0, 1200)}`
  ]
}

export function installDependencies(root) {
  const npmCli = process.env.npm_execpath
  const args = ['ci', '--include=dev', '--include=optional', '--no-audit', '--no-fund']
  const command = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(command, npmCli ? [npmCli, ...args] : args, {
    cwd: root, stdio: 'inherit', shell: !npmCli && process.platform === 'win32'
  })
  if (result.error || result.status !== 0) {
    throw new Error(`Instalação interrompida; o frontend não será iniciado com dependências incompletas. Corrija o erro do npm acima e tente novamente. ${result.error?.message || `Saída: ${result.status ?? result.signal}`}`)
  }
}

export function ensureDependencies({ root = projectRoot, checkOnly = false, install = installDependencies, probe = probeToolchain, log = console.log } = {}) {
  assertNodeVersion()
  const inspect = () => { const problems = dependencyProblems(root); return problems.length ? problems : probe(root) }
  const before = inspect()
  if (!before.length) return { installed: false }
  if (checkOnly) throw new Error(`Dependências desatualizadas/incompletas:\n- ${before.join('\n- ')}\nExecute npm run deps:ensure ou ./script/run-local.sh.`)
  log(`Sincronizando dependências com package-lock.json (${before.length} problema(s); ${before[0]}).`)
  install(root)
  const after = inspect()
  if (after.length) throw new Error(`Instalação terminou, mas a verificação ainda falhou:\n- ${after.join('\n- ')}`)
  log('Dependências verificadas. Inicialização liberada.')
  return { installed: true }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    ensureDependencies({ checkOnly: process.argv.includes('--check') })
    console.log('Dependências do frontend: OK')
  } catch (error) { console.error(`ERRO: ${error.message}`); process.exitCode = 1 }
}
