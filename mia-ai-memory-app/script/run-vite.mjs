import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { ensureDependencies, projectRoot } from './ensure-dependencies.mjs'

const [command, ...args] = process.argv.slice(2)
if (!['dev', 'build', 'preview'].includes(command)) {
  console.error('Uso: node script/run-vite.mjs <dev|build|preview> [opções do Vite]')
  process.exitCode = 1
} else {
  try {
    ensureDependencies()
    const viteArgs = command === 'dev' ? args : [command, ...args]
    const child = spawn(process.execPath, [join(projectRoot, 'node_modules/vite/bin/vite.js'), ...viteArgs], {
      cwd: projectRoot, stdio: 'inherit'
    })
    const onInt = () => child.kill('SIGINT')
    const onTerm = () => child.kill('SIGTERM')
    process.on('SIGINT', onInt)
    process.on('SIGTERM', onTerm)
    child.on('error', error => { console.error(`Vite não iniciou: ${error.message}`); process.exitCode = 1 })
    child.on('exit', (code, signal) => {
      process.removeListener('SIGINT', onInt)
      process.removeListener('SIGTERM', onTerm)
      process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143)
    })
  } catch (error) { console.error(`ERRO: ${error.message}`); process.exitCode = 1 }
}
