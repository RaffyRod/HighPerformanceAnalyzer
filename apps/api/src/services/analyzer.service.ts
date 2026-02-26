import { load } from 'cheerio'
import { launch } from 'chrome-launcher'
import lighthouse from 'lighthouse'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type {
  AnalyzeRequest,
  AnalyzeResponse,
  UrlInsights,
  LanguageCode,
} from '@hpa/shared/src/index.js'
import { t } from '../utils/i18n.js'

interface K6Summary {
  metrics?: Record<
    string,
    {
      avg?: number
      'p(95)'?: number
      rate?: number
    }
  >
}

interface LighthouseAudit {
  id?: string
  title: string
  score?: number | null
  numericValue?: number
  details?: unknown
  description?: string
  displayValue?: string
}

const MAX_URLS = 5
const REPORTS_DIR = path.resolve(process.cwd(), 'reports')
const HISTORY_DIR = path.join(REPORTS_DIR, 'history')

interface HistoricalRun {
  reportId: string
  analyzedAt: string
  baseUrl: string
  results: UrlInsights[]
}

const toKb = (value: number): number => Number((value / 1024).toFixed(2))

const normalizeUrl = (rawUrl: string): string => {
  const url = new URL(rawUrl)
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

const getHistoryKeyFromUrl = (rawUrl: string): string => {
  const normalized = new URL(normalizeUrl(rawUrl))
  return `${normalized.protocol.replace(':', '')}-${normalized.host}`.replace(
    /[^a-zA-Z0-9.-]/g,
    '_',
  )
}

const getHistoryPath = (baseUrl: string): string =>
  path.join(HISTORY_DIR, `${getHistoryKeyFromUrl(baseUrl)}.json`)

const readHistory = async (baseUrl: string): Promise<HistoricalRun[]> => {
  try {
    const data = await fs.readFile(getHistoryPath(baseUrl), 'utf-8')
    const parsed = JSON.parse(data) as HistoricalRun[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const writeHistory = async (baseUrl: string, run: HistoricalRun): Promise<void> => {
  const previous = await readHistory(baseUrl)
  const next = [...previous, run].slice(-20)
  await fs.mkdir(HISTORY_DIR, { recursive: true })
  await fs.writeFile(getHistoryPath(baseUrl), JSON.stringify(next, null, 2), 'utf-8')
}

const subtractNullable = (current: number | null, previous: number | null): number | null => {
  if (typeof current !== 'number' || typeof previous !== 'number') return null
  return Number((current - previous).toFixed(2))
}

const discoverUrls = async (request: AnalyzeRequest): Promise<string[]> => {
  const startUrl = normalizeUrl(request.url)
  const headers: HeadersInit = request.bearerToken
    ? { Authorization: `Bearer ${request.bearerToken}` }
    : {}

  const response = await fetch(startUrl, { headers })

  if (!response.ok) {
    throw new Error(`Failed to fetch target URL. Status: ${response.status}`)
  }

  const html = await response.text()
  const $ = load(html)
  const base = new URL(startUrl)
  const found = new Set<string>([startUrl])

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')
    if (!href) return
    try {
      const parsed = new URL(href, base)
      if (parsed.origin === base.origin) {
        found.add(parsed.toString().replace(/\/$/, ''))
      }
    } catch {
      return
    }
  })

  return [...found].slice(0, MAX_URLS)
}

const readNumericAudit = (
  audits: Record<string, { numericValue?: number }>,
  key: string,
): number | null => {
  const value = audits[key]?.numericValue
  return typeof value === 'number' ? Math.round(value) : null
}

const getResourceSizes = (
  details: unknown,
): {
  imageBytesKb: number
  videoBytesKb: number
} => {
  if (!details || typeof details !== 'object') {
    return { imageBytesKb: 0, videoBytesKb: 0 }
  }

  const maybeItems = (
    details as { items?: Array<{ resourceType?: string; transferSize?: number }> }
  ).items

  if (!Array.isArray(maybeItems)) {
    return { imageBytesKb: 0, videoBytesKb: 0 }
  }

  const imageBytes = maybeItems
    .filter((item) => item.resourceType === 'image')
    .reduce((sum, item) => sum + (item.transferSize ?? 0), 0)
  const videoBytes = maybeItems
    .filter((item) => item.resourceType === 'media')
    .reduce((sum, item) => sum + (item.transferSize ?? 0), 0)

  return { imageBytesKb: toKb(imageBytes), videoBytesKb: toKb(videoBytes) }
}

const runLighthouse = async (
  url: string,
): Promise<{
  performanceScore: number
  firstContentfulPaintMs: number | null
  largestContentfulPaintMs: number | null
  timeToInteractiveMs: number | null
  totalByteWeightKb: number
  imageBytesKb: number
  videoBytesKb: number
  lighthouseSuggestions: string[]
  finalScreenshotDataUrl: string | null
  opportunities: Array<{ title: string; detail: string; score: number | null }>
}> => {
  const chrome = await launch({ chromeFlags: ['--headless', '--no-sandbox'] })

  try {
    const runnerResult = await lighthouse(
      url,
      {
        port: chrome.port,
        output: 'json',
        onlyCategories: ['performance'],
      },
      undefined,
    )

    if (!runnerResult?.lhr) {
      throw new Error('Lighthouse did not return a report.')
    }

    const { lhr } = runnerResult
    const audits = lhr.audits as Record<string, LighthouseAudit>
    const perfScore = Number((lhr.categories.performance?.score ?? 0).toFixed(2))
    const totalBytes = audits['total-byte-weight']?.numericValue ?? 0
    const { imageBytesKb, videoBytesKb } = getResourceSizes(audits['resource-summary']?.details)

    const suggestions = Object.values(audits)
      .filter((audit) => typeof audit.score === 'number' && audit.score < 0.9)
      .slice(0, 3)
      .map((audit) => audit.title)
    const opportunities = Object.values(audits)
      .filter((audit) => typeof audit.score === 'number' && audit.score < 0.9)
      .slice(0, 6)
      .map((audit) => ({
        title: audit.title,
        detail: audit.displayValue || audit.description || 'No additional details.',
        score: typeof audit.score === 'number' ? Number(audit.score.toFixed(2)) : null,
      }))
    const finalScreenshotDataUrl =
      (audits['final-screenshot']?.details as { data?: string } | undefined)?.data ?? null

    return {
      performanceScore: perfScore,
      firstContentfulPaintMs: readNumericAudit(audits, 'first-contentful-paint'),
      largestContentfulPaintMs: readNumericAudit(audits, 'largest-contentful-paint'),
      timeToInteractiveMs: readNumericAudit(audits, 'interactive'),
      totalByteWeightKb: toKb(totalBytes),
      imageBytesKb,
      videoBytesKb,
      lighthouseSuggestions: suggestions,
      finalScreenshotDataUrl,
      opportunities,
    }
  } finally {
    try {
      await chrome.kill()
    } catch (error) {
      void error
    }
  }
}

const runK6 = async (url: string, bearerToken?: string): Promise<K6Summary> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hpa-k6-'))
  const scriptPath = path.join(tempDir, 'script.js')
  const summaryPath = path.join(tempDir, 'summary.json')
  const authHeader = bearerToken ? `'Authorization': 'Bearer ${bearerToken}',` : ''

  const k6Script = `
import http from 'k6/http'
import { check, sleep } from 'k6'

export const options = {
  vus: 5,
  duration: '10s',
}

export default function() {
  const response = http.get('${url}', { headers: { ${authHeader} } })
  check(response, { 'status is 200': (r) => r.status >= 200 && r.status < 400 })
  sleep(1)
}
`

  await fs.writeFile(scriptPath, k6Script, 'utf-8')

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('k6', ['run', scriptPath, '--summary-export', summaryPath, '--quiet'], {
      shell: true,
    })

    let stderr = ''

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    proc.on('error', (error) => reject(error))
    proc.on('close', (code) => {
      if (code === 0) return resolve()
      reject(
        new Error(stderr || 'k6 execution failed. Ensure k6 is installed and available in PATH.'),
      )
    })
  })

  const summaryRaw = await fs.readFile(summaryPath, 'utf-8')
  return JSON.parse(summaryRaw) as K6Summary
}

const evaluateViolations = (
  lang: LanguageCode,
  lighthouseResult: Awaited<ReturnType<typeof runLighthouse>>,
  k6Summary: K6Summary,
): {
  issues: string[]
  suggestions: string[]
  rootCauses: UrlInsights['rootCauses']
  k6Metrics: Pick<UrlInsights, 'callTimeAvgMs' | 'callTimeP95Ms' | 'callsFailedRate'>
} => {
  const issues: string[] = []
  const suggestions = new Set<string>()
  const rootCauses: UrlInsights['rootCauses'] = []

  const avg = k6Summary.metrics?.http_req_duration?.avg
  const p95 = k6Summary.metrics?.http_req_duration?.['p(95)']
  const failRate = k6Summary.metrics?.http_req_failed?.rate

  if (lighthouseResult.performanceScore < 0.8) {
    issues.push(t(lang, 'lowPerformance'))
    suggestions.add(t(lang, 'reduceJs'))
    rootCauses.push({
      cause: lang === 'es' ? 'Costo alto de render y ejecución' : 'High render and execution cost',
      evidence:
        lang === 'es'
          ? `Performance score en ${lighthouseResult.performanceScore}.`
          : `Performance score at ${lighthouseResult.performanceScore}.`,
      impact: 'high',
      possibleFix:
        lang === 'es'
          ? 'Reducir JS no usado, diferir recursos no críticos y mejorar caché.'
          : 'Reduce unused JS, defer non-critical resources, and improve caching.',
    })
  }
  if ((lighthouseResult.firstContentfulPaintMs ?? 0) > 1800) {
    issues.push(t(lang, 'slowFcp'))
    suggestions.add(t(lang, 'cacheAssets'))
    rootCauses.push({
      cause: lang === 'es' ? 'Primer render lento (FCP)' : 'Slow first render (FCP)',
      evidence:
        lang === 'es'
          ? `FCP en ${lighthouseResult.firstContentfulPaintMs} ms (umbral: 1800 ms).`
          : `FCP at ${lighthouseResult.firstContentfulPaintMs} ms (threshold: 1800 ms).`,
      impact: 'medium',
      possibleFix:
        lang === 'es'
          ? 'Priorizar CSS crítico, precargar fuentes y cachear estáticos.'
          : 'Prioritize critical CSS, preload fonts, and cache static assets.',
    })
  }
  if ((lighthouseResult.largestContentfulPaintMs ?? 0) > 2500) {
    issues.push(t(lang, 'slowLcp'))
    suggestions.add(t(lang, 'improveImages'))
    rootCauses.push({
      cause:
        lang === 'es'
          ? 'Elemento principal tarda en cargar (LCP)'
          : 'Main content element loads too late (LCP)',
      evidence:
        lang === 'es'
          ? `LCP en ${lighthouseResult.largestContentfulPaintMs} ms (umbral: 2500 ms).`
          : `LCP at ${lighthouseResult.largestContentfulPaintMs} ms (threshold: 2500 ms).`,
      impact: 'high',
      possibleFix:
        lang === 'es'
          ? 'Optimizar imagen/hero principal, lazy-load selectivo y reducir bloqueo de render.'
          : 'Optimize hero image/content, use selective lazy-loading, and reduce render blocking.',
    })
  }
  if (lighthouseResult.totalByteWeightKb > 2048) {
    issues.push(t(lang, 'heavyPage'))
    suggestions.add(t(lang, 'improveImages'))
    rootCauses.push({
      cause: lang === 'es' ? 'Peso total de página elevado' : 'Page transfer size is too large',
      evidence:
        lang === 'es'
          ? `Transferencia total en ${lighthouseResult.totalByteWeightKb} KB (umbral: 2048 KB).`
          : `Total transfer at ${lighthouseResult.totalByteWeightKb} KB (threshold: 2048 KB).`,
      impact: 'high',
      possibleFix:
        lang === 'es'
          ? 'Comprimir imágenes/video, eliminar payload innecesario y activar compresión HTTP.'
          : 'Compress images/media, remove unnecessary payload, and enable HTTP compression.',
    })
  }
  if (typeof avg === 'number' && avg > 800) {
    issues.push(t(lang, 'slowCalls'))
    suggestions.add(t(lang, 'optimizeBackend'))
    rootCauses.push({
      cause: lang === 'es' ? 'Latencia de API elevada' : 'High API latency',
      evidence:
        lang === 'es'
          ? `Duración promedio de requests en ${avg.toFixed(2)} ms (umbral: 800 ms).`
          : `Average request duration at ${avg.toFixed(2)} ms (threshold: 800 ms).`,
      impact: 'medium',
      possibleFix:
        lang === 'es'
          ? 'Optimizar queries, agregar caché y revisar dependencias lentas de backend.'
          : 'Optimize queries, add caching, and review slow backend dependencies.',
    })
  }
  if (typeof failRate === 'number' && failRate > 0.01) {
    issues.push(t(lang, 'highFailureRate'))
    suggestions.add(t(lang, 'optimizeBackend'))
    rootCauses.push({
      cause: lang === 'es' ? 'Tasa de error alta en llamadas' : 'High request error rate',
      evidence:
        lang === 'es'
          ? `Fallas en ${(failRate * 100).toFixed(2)}% de requests (umbral: 1%).`
          : `Failures in ${(failRate * 100).toFixed(2)}% of requests (threshold: 1%).`,
      impact: 'high',
      possibleFix:
        lang === 'es'
          ? 'Analizar status codes, timeouts y retries para aislar endpoints inestables.'
          : 'Inspect status codes, timeouts, and retries to isolate unstable endpoints.',
    })
  }

  for (const lhSuggestion of lighthouseResult.lighthouseSuggestions) {
    suggestions.add(lhSuggestion)
  }

  return {
    issues,
    suggestions: [...suggestions],
    rootCauses,
    k6Metrics: {
      callTimeAvgMs: typeof avg === 'number' ? Number(avg.toFixed(2)) : null,
      callTimeP95Ms: typeof p95 === 'number' ? Number(p95.toFixed(2)) : null,
      callsFailedRate: typeof failRate === 'number' ? Number((failRate * 100).toFixed(2)) : null,
    },
  }
}

const withComparison = (
  currentResults: UrlInsights[],
  previousRun: HistoricalRun | null,
): UrlInsights[] => {
  if (!previousRun) {
    return currentResults.map((result) => ({
      ...result,
      comparison: {
        status: 'new',
        previousAnalyzedAt: null,
        deltas: {
          performanceScore: null,
          firstContentfulPaintMs: null,
          largestContentfulPaintMs: null,
          timeToInteractiveMs: null,
          totalByteWeightKb: null,
          callTimeP95Ms: null,
        },
      },
    }))
  }

  const previousByPage = new Map(previousRun.results.map((item) => [item.pageUrl, item]))

  return currentResults.map((result) => {
    const previous = previousByPage.get(result.pageUrl)
    if (!previous) {
      return {
        ...result,
        comparison: {
          status: 'new',
          previousAnalyzedAt: previousRun.analyzedAt,
          deltas: {
            performanceScore: null,
            firstContentfulPaintMs: null,
            largestContentfulPaintMs: null,
            timeToInteractiveMs: null,
            totalByteWeightKb: null,
            callTimeP95Ms: null,
          },
        },
      }
    }

    const deltas = {
      performanceScore: subtractNullable(result.performanceScore, previous.performanceScore),
      firstContentfulPaintMs: subtractNullable(
        result.firstContentfulPaintMs,
        previous.firstContentfulPaintMs,
      ),
      largestContentfulPaintMs: subtractNullable(
        result.largestContentfulPaintMs,
        previous.largestContentfulPaintMs,
      ),
      timeToInteractiveMs: subtractNullable(
        result.timeToInteractiveMs,
        previous.timeToInteractiveMs,
      ),
      totalByteWeightKb: subtractNullable(result.totalByteWeightKb, previous.totalByteWeightKb),
      callTimeP95Ms: subtractNullable(result.callTimeP95Ms, previous.callTimeP95Ms),
    }

    const improvements = [
      typeof deltas.performanceScore === 'number' ? deltas.performanceScore > 0 : false,
      typeof deltas.firstContentfulPaintMs === 'number' ? deltas.firstContentfulPaintMs < 0 : false,
      typeof deltas.largestContentfulPaintMs === 'number'
        ? deltas.largestContentfulPaintMs < 0
        : false,
      typeof deltas.timeToInteractiveMs === 'number' ? deltas.timeToInteractiveMs < 0 : false,
      typeof deltas.totalByteWeightKb === 'number' ? deltas.totalByteWeightKb < 0 : false,
      typeof deltas.callTimeP95Ms === 'number' ? deltas.callTimeP95Ms < 0 : false,
    ].filter(Boolean).length

    const regressions = [
      typeof deltas.performanceScore === 'number' ? deltas.performanceScore < 0 : false,
      typeof deltas.firstContentfulPaintMs === 'number' ? deltas.firstContentfulPaintMs > 0 : false,
      typeof deltas.largestContentfulPaintMs === 'number'
        ? deltas.largestContentfulPaintMs > 0
        : false,
      typeof deltas.timeToInteractiveMs === 'number' ? deltas.timeToInteractiveMs > 0 : false,
      typeof deltas.totalByteWeightKb === 'number' ? deltas.totalByteWeightKb > 0 : false,
      typeof deltas.callTimeP95Ms === 'number' ? deltas.callTimeP95Ms > 0 : false,
    ].filter(Boolean).length

    const status =
      improvements > regressions ? 'improved' : regressions > improvements ? 'regressed' : 'stable'

    return {
      ...result,
      comparison: {
        status,
        previousAnalyzedAt: previousRun.analyzedAt,
        deltas,
      },
    }
  })
}

const buildHtmlReport = (payload: AnalyzeResponse): string => {
  const labels =
    payload.language === 'es'
      ? {
          title: 'High Performance Analyzer - Lighthouse++',
          subtitle: 'Reporte mejorado de performance con causa raíz y solución propuesta',
          health: 'Estado general',
          healthScore: 'Score promedio',
          pagesAnalyzed: 'Páginas analizadas',
          criticalFindings: 'Hallazgos críticos',
          noData: 'Sin datos',
          causes: 'Causas raíz (priorizadas)',
          possibleFix: 'Posible solución',
          opportunities: 'Oportunidades de mejora detectadas por Lighthouse',
          metrics: 'Métricas clave',
          screenshot: 'Captura de referencia',
          beforeAfter: 'Before/After',
          previousRun: 'Ejecución previa',
          comparisonStatus: 'Estado comparativo',
          improved: 'Mejoró',
          regressed: 'Empeoró',
          stable: 'Estable',
          newlyDiscovered: 'Nueva URL detectada',
          evidenceByIssue: 'Evidencia por hallazgo',
          delta: 'Delta',
          impactHigh: 'Alto',
          impactMedium: 'Medio',
          impactLow: 'Bajo',
        }
      : {
          title: 'High Performance Analyzer - Lighthouse++',
          subtitle: 'Enhanced performance report with root cause and suggested fix',
          health: 'Overall health',
          healthScore: 'Average score',
          pagesAnalyzed: 'Pages analyzed',
          criticalFindings: 'Critical findings',
          noData: 'No data',
          causes: 'Root causes (prioritized)',
          possibleFix: 'Possible fix',
          opportunities: 'Lighthouse opportunities',
          metrics: 'Key metrics',
          screenshot: 'Reference screenshot',
          beforeAfter: 'Before/After',
          previousRun: 'Previous run',
          comparisonStatus: 'Comparison status',
          improved: 'Improved',
          regressed: 'Regressed',
          stable: 'Stable',
          newlyDiscovered: 'Newly discovered URL',
          evidenceByIssue: 'Evidence by finding',
          delta: 'Delta',
          impactHigh: 'High',
          impactMedium: 'Medium',
          impactLow: 'Low',
        }

  const averageScore = payload.results.length
    ? Number(
        (
          payload.results.reduce((sum, item) => sum + item.performanceScore, 0) /
          payload.results.length
        ).toFixed(2),
      )
    : 0
  const criticalFindings = payload.results.reduce((sum, item) => sum + item.rootCauses.length, 0)

  const rows = payload.results
    .map(
      (result) => `
      <section class="card">
        <h2>${result.pageUrl}</h2>
        <div class="row-meta">
          <span>${labels.comparisonStatus}:</span>
          <span class="status ${result.comparison?.status ?? 'new'}">${
            result.comparison?.status === 'improved'
              ? labels.improved
              : result.comparison?.status === 'regressed'
                ? labels.regressed
                : result.comparison?.status === 'stable'
                  ? labels.stable
                  : labels.newlyDiscovered
          }</span>
        </div>
        <div class="kpis">
          <div class="kpi"><span>Score</span><b>${result.performanceScore}</b></div>
          <div class="kpi"><span>FCP</span><b>${result.firstContentfulPaintMs ?? 'N/A'} ms</b></div>
          <div class="kpi"><span>LCP</span><b>${result.largestContentfulPaintMs ?? 'N/A'} ms</b></div>
          <div class="kpi"><span>TTI</span><b>${result.timeToInteractiveMs ?? 'N/A'} ms</b></div>
          <div class="kpi"><span>Payload</span><b>${result.totalByteWeightKb} KB</b></div>
          <div class="kpi"><span>Req p95</span><b>${result.callTimeP95Ms ?? 'N/A'} ms</b></div>
        </div>
        <h3>${labels.beforeAfter}</h3>
        <ul>
          <li>${labels.previousRun}: <b>${result.comparison?.previousAnalyzedAt ?? labels.noData}</b></li>
          <li>Score ${labels.delta}: <b>${result.comparison?.deltas.performanceScore ?? labels.noData}</b></li>
          <li>FCP ${labels.delta}: <b>${result.comparison?.deltas.firstContentfulPaintMs ?? labels.noData} ms</b></li>
          <li>LCP ${labels.delta}: <b>${result.comparison?.deltas.largestContentfulPaintMs ?? labels.noData} ms</b></li>
          <li>TTI ${labels.delta}: <b>${result.comparison?.deltas.timeToInteractiveMs ?? labels.noData} ms</b></li>
          <li>Payload ${labels.delta}: <b>${result.comparison?.deltas.totalByteWeightKb ?? labels.noData} KB</b></li>
          <li>Req p95 ${labels.delta}: <b>${result.comparison?.deltas.callTimeP95Ms ?? labels.noData} ms</b></li>
        </ul>
        <h3>${labels.metrics}</h3>
        <ul>
          <li>Images: <b>${result.imageBytesKb} KB</b></li>
          <li>Video/Media: <b>${result.videoBytesKb} KB</b></li>
          <li>Calls avg: <b>${result.callTimeAvgMs ?? 'N/A'} ms</b></li>
          <li>Failure rate: <b>${result.callsFailedRate ?? 'N/A'}%</b></li>
        </ul>
        <h3>${labels.causes}</h3>
        <ul>
          ${
            result.rootCauses.length
              ? result.rootCauses
                  .map(
                    (item) => `<li>
                <div><b>${item.cause}</b> <span class="impact ${item.impact}">${
                  item.impact === 'high'
                    ? labels.impactHigh
                    : item.impact === 'medium'
                      ? labels.impactMedium
                      : labels.impactLow
                }</span></div>
                <div class="evidence">${item.evidence}</div>
                <div class="fix"><b>${labels.possibleFix}:</b> ${item.possibleFix}</div>
              </li>`,
                  )
                  .join('')
              : `<li>${labels.noData}</li>`
          }
        </ul>
        <h3>${labels.evidenceByIssue}</h3>
        <ul>${result.rootCauses.map((item) => `<li>${item.cause} -> ${item.evidence}</li>`).join('') || `<li>${labels.noData}</li>`}</ul>
        <h3>${labels.opportunities}</h3>
        <ul>
          ${
            result.opportunities.length
              ? result.opportunities
                  .map(
                    (item) =>
                      `<li><b>${item.title}</b> (${item.score ?? 'N/A'}) - ${item.detail}</li>`,
                  )
                  .join('')
              : `<li>${labels.noData}</li>`
          }
        </ul>
        ${
          result.finalScreenshotDataUrl
            ? `<h3>${labels.screenshot}</h3><img class="shot" src="${result.finalScreenshotDataUrl}" alt="Lighthouse screenshot for ${result.pageUrl}" />`
            : ''
        }
      </section>
    `,
    )
    .join('')

  return `
<!doctype html>
<html lang="${payload.language}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Performance Report</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 24px; background: #0f172a; color: #e2e8f0; }
      h1 { margin-bottom: 4px; }
      .meta { color: #94a3b8; margin-bottom: 24px; }
      .hero { background: #111c35; border: 1px solid #1f2f53; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
      .hero-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
      .hero-item { background: #0e172d; border: 1px solid #22345f; border-radius: 8px; padding: 10px; }
      .hero-item span { color: #8aa0cc; display: block; font-size: 12px; }
      .hero-item b { font-size: 18px; }
      .card { background: #1e293b; border-radius: 8px; padding: 16px; margin-bottom: 16px; border: 1px solid #2a3a56; }
      .row-meta { display: flex; gap: 8px; align-items: center; color: #b8c8e6; margin-bottom: 8px; font-size: 13px; }
      .status { display: inline-block; padding: 3px 8px; border-radius: 999px; font-weight: 600; }
      .status.improved { background: #163126; color: #a6ebc8; border: 1px solid #2d6a4f; }
      .status.regressed { background: #3a1520; color: #ffb6c4; border: 1px solid #6d2638; }
      .status.stable { background: #1b2941; color: #bfd3fb; border: 1px solid #365890; }
      .status.new { background: #312311; color: #ffe3ae; border: 1px solid #705324; }
      .kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
      .kpi { background: #0f172a; border: 1px solid #243550; border-radius: 8px; padding: 10px; }
      .kpi span { display: block; color: #9bb0d8; font-size: 12px; }
      .kpi b { font-size: 17px; }
      ul { padding-left: 20px; }
      li { margin-bottom: 8px; }
      .evidence { color: #9db0d4; font-size: 13px; }
      .fix { color: #d4def3; font-size: 13px; }
      .impact { display: inline-block; font-size: 11px; margin-left: 6px; border-radius: 999px; padding: 2px 7px; border: 1px solid transparent; }
      .impact.high { background: #3a1520; color: #ffb6c4; border-color: #6d2638; }
      .impact.medium { background: #3a2f13; color: #ffe1a5; border-color: #6a5523; }
      .impact.low { background: #163126; color: #a6ebc8; border-color: #2d6a4f; }
      .shot { width: 100%; max-width: 900px; border-radius: 8px; border: 1px solid #2a3a56; }
    </style>
  </head>
  <body>
    <h1>${labels.title}</h1>
    <p class="meta">${labels.subtitle}</p>
    <div class="hero">
      <p class="meta">Base URL: ${payload.baseUrl} | Analyzed at: ${payload.analyzedAt}</p>
      <div class="hero-grid">
        <div class="hero-item">
          <span>${labels.healthScore}</span>
          <b>${averageScore}</b>
        </div>
        <div class="hero-item">
          <span>${labels.pagesAnalyzed}</span>
          <b>${payload.results.length}</b>
        </div>
        <div class="hero-item">
          <span>${labels.criticalFindings}</span>
          <b>${criticalFindings}</b>
        </div>
      </div>
    </div>
    ${rows}
  </body>
</html>
`
}

export const analyzeWebsite = async (request: AnalyzeRequest): Promise<AnalyzeResponse> => {
  const discoveredUrls = await discoverUrls(request)
  const reportId = randomUUID()
  const results: UrlInsights[] = []
  const history = await readHistory(request.url)
  const previousRun: HistoricalRun | null = history.length
    ? (history[history.length - 1] ?? null)
    : null

  for (const discoveredUrl of discoveredUrls) {
    const lighthouseResult = await runLighthouse(discoveredUrl)
    const k6Summary = await runK6(discoveredUrl, request.bearerToken)
    const { issues, suggestions, rootCauses, k6Metrics } = evaluateViolations(
      request.language,
      lighthouseResult,
      k6Summary,
    )

    results.push({
      pageUrl: discoveredUrl,
      performanceScore: lighthouseResult.performanceScore,
      firstContentfulPaintMs: lighthouseResult.firstContentfulPaintMs,
      largestContentfulPaintMs: lighthouseResult.largestContentfulPaintMs,
      timeToInteractiveMs: lighthouseResult.timeToInteractiveMs,
      totalByteWeightKb: lighthouseResult.totalByteWeightKb,
      imageBytesKb: lighthouseResult.imageBytesKb,
      videoBytesKb: lighthouseResult.videoBytesKb,
      callTimeAvgMs: k6Metrics.callTimeAvgMs,
      callTimeP95Ms: k6Metrics.callTimeP95Ms,
      callsFailedRate: k6Metrics.callsFailedRate,
      issues,
      suggestions,
      finalScreenshotDataUrl: lighthouseResult.finalScreenshotDataUrl,
      rootCauses,
      opportunities: lighthouseResult.opportunities,
    })
  }

  const comparedResults = withComparison(results, previousRun)

  await fs.mkdir(REPORTS_DIR, { recursive: true })
  const htmlFileName = `${reportId}.html`
  const htmlReportPath = `/api/report/${reportId}`

  const payload: AnalyzeResponse = {
    reportId,
    language: request.language,
    baseUrl: request.url,
    discoveredUrls,
    analyzedAt: new Date().toISOString(),
    results: comparedResults,
    htmlReportPath,
    previousReportId: previousRun?.reportId ?? null,
  }

  const html = buildHtmlReport(payload)
  await fs.writeFile(path.join(REPORTS_DIR, htmlFileName), html, 'utf-8')
  await writeHistory(request.url, {
    reportId,
    analyzedAt: payload.analyzedAt,
    baseUrl: request.url,
    results: comparedResults,
  })

  return payload
}

export const readReportById = async (id: string): Promise<string> => {
  const safeId = id.replace(/[^a-zA-Z0-9-]/g, '')
  const reportPath = path.join(REPORTS_DIR, `${safeId}.html`)
  return fs.readFile(reportPath, 'utf-8')
}
