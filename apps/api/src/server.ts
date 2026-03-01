import Fastify from 'fastify'
import cors from '@fastify/cors'
import { analyzeWebsite, readReportById } from './services/analyzer.service.js'
import type { AnalyzeRequest } from '@hpa/shared'
import { validateAndNormalizeAnalyzeRequest } from './utils/analyze-request.js'

const app = Fastify({ logger: true })

await app.register(cors, { origin: true })

app.get('/api/health', async () => ({ ok: true }))

app.post<{ Body: AnalyzeRequest }>('/api/analyze', async (request, reply) => {
  const validation = validateAndNormalizeAnalyzeRequest(request.body)
  if (!validation.ok) {
    return reply.code(validation.statusCode).send({ message: validation.message })
  }

  try {
    const report = await analyzeWebsite(validation.payload)
    return report
  } catch (error) {
    request.log.error(error)
    const details = error instanceof Error ? error.message : 'Unknown error'
    return reply.code(500).send({
      message: `Analysis failed: ${details}`,
    })
  }
})

app.get<{ Params: { id: string } }>('/api/report/:id', async (request, reply) => {
  try {
    const html = await readReportById(request.params.id)
    reply.header('Content-Type', 'text/html; charset=utf-8')
    return html
  } catch {
    return reply.code(404).send({ message: 'Report not found' })
  }
})

const port = Number(process.env.PORT || 3000)
const host = '0.0.0.0'

app.listen({ port, host })
