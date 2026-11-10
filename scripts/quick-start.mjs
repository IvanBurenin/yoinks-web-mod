import {spawn} from 'node:child_process'
import {existsSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const npmCli = process.env.npm_execpath
const npmCommand = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm'
const useShell = !npmCli && process.platform === 'win32'
const open = !process.argv.includes('--no-open')

const major = Number(process.versions.node.split('.')[0])
if (!Number.isFinite(major) || major < 18) {
  console.error(`yoinks needs Node 18 or newer (found ${process.version}).`)
  process.exit(1)
}

function run(args) {
  return new Promise((resolve, reject) => {
    const command = npmCli ? process.execPath : npmCommand
    const commandArgs = npmCli ? [npmCli, ...args] : args
    const child = spawn(command, commandArgs, {cwd: root, stdio: 'inherit', shell: useShell})
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`npm ${args.join(' ')} exited with code ${code}`))
    })
  })
}

try {
  const hasDeps = existsSync(path.join(root, 'node_modules', 'tsx', 'package.json'))
  if (!hasDeps) {
    console.log('')
    console.log('  installing dependencies (first run only)…')
    console.log('')
    await run(['install'])
  }

  console.log('')
  console.log(`  starting yoinks web${open ? ' and opening the browser' : ''}…`)
  console.log('')

  await run(['run', 'web', '--', ...(open ? ['--open'] : [])]).catch(() => {
    // npm already printed the reason (port in use, missing build, etc.)
    process.exitCode = 1
  })
} catch (error) {
  console.error(`\n  could not start yoinks: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
