import { spawn } from 'node:child_process'
import net from 'node:net'

const isPortFree = async (port) =>
  new Promise((resolve) => {
    const server = net.createServer()

    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })

    server.listen(port, '127.0.0.1')
  })

const findFreePort = async (startPort, exclude = new Set()) => {
  for (let port = startPort; port < startPort + 200; port += 1) {
    if (exclude.has(port)) continue
    const free = await isPortFree(port)
    if (free) return port
  }

  throw new Error(`No free port found from ${startPort} to ${startPort + 199}.`)
}

const run = async () => {
  const preferredApiPort = Number(process.env.API_PORT || 3000)
  const preferredWebPort = Number(process.env.WEB_PORT || 5173)
  const apiPort = await findFreePort(preferredApiPort)
  const webPort = await findFreePort(preferredWebPort, new Set([apiPort]))
  const apiTarget = `http://localhost:${apiPort}`

  console.log(`API will run on ${apiTarget}`)
  console.log(`Web will run on http://localhost:${webPort}`)

  const apiProcess = spawn('pnpm', ['--filter', '@hpa/api', 'dev'], {
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      PORT: String(apiPort),
    },
  })

  const webProcess = spawn('pnpm', ['--filter', '@hpa/web', 'dev'], {
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      WEB_PORT: String(webPort),
      VITE_API_TARGET: apiTarget,
    },
  })

  const shutdown = () => {
    apiProcess.kill()
    webProcess.kill()
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  apiProcess.on('exit', (code) => {
    webProcess.kill()
    process.exit(code ?? 0)
  })

  webProcess.on('exit', (code) => {
    apiProcess.kill()
    process.exit(code ?? 0)
  })
}

run()
