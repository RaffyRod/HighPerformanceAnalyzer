import Fastify from 'fastify'
import cors from '@fastify/cors'
import { analyzeWebsite, readReportById } from './services/analyzer.service.js'
import type { AnalyzeRequest, LanguageCode } from '@hpa/shared/src/index.js'

const app = Fastify({ logger: true })

await app.register(cors, { origin: true })

app.get('/api/health', async () => ({ ok: true }))

app.post<{ Body: AnalyzeRequest }>('/api/analyze', async (request, reply) => {
  const body = request.body

  if (!body?.url) {
    return reply.code(400).send({ message: 'url is required' })
  }

  const language: LanguageCode = body.language === 'es' ? 'es' : 'en'
  const payload: AnalyzeRequest = {
    url: body.url,
    bearerToken: body.bearerToken?.trim() || undefined,
    language,
    includeDiscoveredUrls: body.includeDiscoveredUrls !== false,
  }

  try {
    const report = await analyzeWebsite(payload)
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
