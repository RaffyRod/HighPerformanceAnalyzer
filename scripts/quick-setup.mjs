import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SETUP_DIR = path.join(ROOT_DIR, '.hpa')
const SETUP_FILE = path.join(SETUP_DIR, 'setup-complete.json')

const runStep = (label, command, args) =>
  new Promise((resolve, reject) => {
    console.log(`\n[quick-setup] ${label}`)
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      stdio: 'inherit',
      shell: true,
    })

    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) return resolve()
      reject(new Error(`[quick-setup] "${label}" failed with exit code ${code ?? 1}.`))
    })
  })

const run = async () => {
  await runStep('Installing workspace dependencies', 'pnpm', ['install'])
  await runStep('Installing Playwright Chromium browser', 'pnpm', [
    '--filter',
    '@hpa/web',
    'exec',
    'playwright',
    'install',
    'chromium',
  ])
  await runStep('Building API workspace', 'pnpm', ['--filter', '@hpa/api', 'build'])
  await runStep('Building web workspace', 'pnpm', ['--filter', '@hpa/web', 'build'])

  await fs.mkdir(SETUP_DIR, { recursive: true })
  await fs.writeFile(
    SETUP_FILE,
    JSON.stringify(
      {
        completedAt: new Date().toISOString(),
        steps: ['pnpm install', 'playwright install chromium', 'api build', 'web build'],
      },
      null,
      2,
    ),
    'utf-8',
  )

  console.log('\n[quick-setup] Setup completed successfully.')
  console.log('[quick-setup] Start the app with: pnpm dev')
}

run()
