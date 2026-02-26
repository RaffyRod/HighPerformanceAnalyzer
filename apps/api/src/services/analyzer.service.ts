import { load } from 'cheerio'
import { launch } from 'chrome-launcher'
import lighthouse from 'lighthouse'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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
const MAX_REPORT_FILES = 5
const CURRENT_FILE_DIR = path.dirname(fileURLToPath(import.meta.url))
const resolveProjectRoot = (): string => {
  const candidates = [process.cwd(), path.resolve(CURRENT_FILE_DIR, '../../../../')]
  const rootPattern = /^[a-zA-Z]:\\$/

  for (const candidate of candidates) {
    let cursor = path.resolve(candidate)

    while (cursor !== path.dirname(cursor)) {
      const hasWorkspaceFile = existsSync(path.join(cursor, 'pnpm-workspace.yaml'))
      const hasGitFolder = existsSync(path.join(cursor, '.git'))

      if (hasWorkspaceFile || hasGitFolder) {
        return cursor
      }

      cursor = path.dirname(cursor)
      if (rootPattern.test(cursor)) break
    }
  }

  return path.resolve(process.cwd())
}

const REPORTS_DIR = process.env.HPA_REPORTS_DIR
  ? path.resolve(process.env.HPA_REPORTS_DIR)
  : path.join(resolveProjectRoot(), 'reports')
const HISTORY_DIR = path.join(REPORTS_DIR, 'history')
const SETUP_DIR = path.join(REPORTS_DIR, '.setup')
const K6_SETUP_FILE = path.join(SETUP_DIR, 'k6-bootstrap.json')
const FALLBACK_REQUESTS = 25
const FALLBACK_CONCURRENCY = 5

let k6ReadyCache: boolean | null = null

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

const getReportIdFromDate = (date: Date): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `analysis-${year}-${month}-${day}`
}

const cleanupOldReports = async (): Promise<void> => {
  const entries = await fs.readdir(REPORTS_DIR, { withFileTypes: true })
  const htmlFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => entry.name)

  if (htmlFiles.length <= MAX_REPORT_FILES) return

  const filesWithStat = await Promise.all(
    htmlFiles.map(async (fileName) => {
      const fullPath = path.join(REPORTS_DIR, fileName)
      const stat = await fs.stat(fullPath)
      return { fileName, fullPath, modifiedAt: stat.mtimeMs }
    }),
  )

  filesWithStat.sort((a, b) => b.modifiedAt - a.modifiedAt)
  const filesToDelete = filesWithStat.slice(MAX_REPORT_FILES)
  await Promise.all(filesToDelete.map((file) => fs.unlink(file.fullPath)))
}

const runCommand = (
  command: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(command, args, {
    shell: true,
    encoding: 'utf-8',
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

const isCommandAvailable = (command: string): boolean => {
  const probeCommand = process.platform === 'win32' ? 'where' : 'which'
  const probe = runCommand(probeCommand, [command])
  return probe.status === 0 && probe.stdout.trim().length > 0
}

const getK6InstallCommands = (): Array<{ command: string; args: string[]; label: string }> => {
  if (process.platform === 'win32') {
    return [
      {
        command: 'winget',
        args: [
          'install',
          '--id',
          'Grafana.k6',
          '-e',
          '--accept-package-agreements',
          '--accept-source-agreements',
        ],
        label: 'winget',
      },
      { command: 'choco', args: ['install', 'k6', '-y'], label: 'choco' },
      { command: 'scoop', args: ['install', 'k6'], label: 'scoop' },
    ]
  }

  if (process.platform === 'darwin') {
    return [{ command: 'brew', args: ['install', 'k6'], label: 'brew' }]
  }

  return []
}

const writeK6SetupLog = async (payload: {
  status: 'installed' | 'failed'
  method: string | null
  details: string
}): Promise<void> => {
  await fs.mkdir(SETUP_DIR, { recursive: true })
  await fs.writeFile(
    K6_SETUP_FILE,
    JSON.stringify(
      {
        ...payload,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf-8',
  )
}

const ensureK6Ready = async (): Promise<boolean> => {
  if (k6ReadyCache !== null) return k6ReadyCache

  if (isCommandAvailable('k6')) {
    k6ReadyCache = true
    return true
  }

  const installers = getK6InstallCommands()
  let lastDetails = 'No supported installer found for this OS.'

  for (const installer of installers) {
    if (!isCommandAvailable(installer.command)) continue

    const result = runCommand(installer.command, installer.args)
    lastDetails =
      result.stderr.trim() || result.stdout.trim() || `Installer ${installer.label} failed.`

    if (isCommandAvailable('k6')) {
      await writeK6SetupLog({
        status: 'installed',
        method: installer.label,
        details: result.stdout.trim() || 'k6 installed successfully.',
      })
      k6ReadyCache = true
      return true
    }
  }

  await writeK6SetupLog({
    status: 'failed',
    method: null,
    details: lastDetails,
  })
  k6ReadyCache = false
  return false
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

const runK6Binary = async (url: string, bearerToken?: string): Promise<K6Summary> => {
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

const runFallbackLoadTest = async (url: string, bearerToken?: string): Promise<K6Summary> => {
  const headers: HeadersInit = bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}
  const durationsMs: number[] = []
  let failedCount = 0
  let nextIndex = 0

  const runSingleRequest = async (): Promise<void> => {
    const startedAt = Date.now()
    const response = await fetch(url, { headers })
    const elapsedMs = Date.now() - startedAt
    durationsMs.push(elapsedMs)
    if (!response.ok) {
      failedCount += 1
    }
  }

  const worker = async (): Promise<void> => {
    while (nextIndex < FALLBACK_REQUESTS) {
      nextIndex += 1
      await runSingleRequest()
    }
  }

  const workers = Array.from({ length: FALLBACK_CONCURRENCY }, () => worker())
  await Promise.all(workers)

  const sortedDurations = [...durationsMs].sort((a, b) => a - b)
  const avg =
    durationsMs.length > 0
      ? durationsMs.reduce((sum, current) => sum + current, 0) / durationsMs.length
      : 0
  const p95Index = Math.max(0, Math.ceil(sortedDurations.length * 0.95) - 1)
  const p95 = sortedDurations[p95Index] ?? 0

  return {
    metrics: {
      http_req_duration: {
        avg: Number(avg.toFixed(2)),
        'p(95)': Number(p95.toFixed(2)),
      },
      http_req_failed: {
        rate: Number((failedCount / FALLBACK_REQUESTS).toFixed(4)),
      },
    },
  }
}

const runK6 = async (url: string, bearerToken?: string): Promise<K6Summary> => {
  const k6Ready = await ensureK6Ready()

  if (k6Ready) {
    return runK6Binary(url, bearerToken)
  }

  console.warn('k6 is unavailable. Falling back to internal HTTP load probe.')
  return runFallbackLoadTest(url, bearerToken)
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
          subtitle: 'Reporte ejecutivo de performance con foco en acciones',
          healthScore: 'Score promedio',
          pagesAnalyzed: 'Páginas analizadas',
          findings: 'Hallazgos',
          noData: 'Sin datos',
          causes: 'Causas raíz',
          possibleFix: 'Posible solución',
          opportunities: 'Oportunidades',
          metrics: 'Métricas',
          screenshot: 'Captura de referencia',
          previousRun: 'Ejecución previa',
          comparisonStatus: 'Estado',
          improved: 'Mejoró',
          regressed: 'Empeoró',
          stable: 'Estable',
          newlyDiscovered: 'Nueva URL',
          delta: 'Delta',
          priority: 'Prioridad',
          topActions: 'Top acciones recomendadas',
          pageBreakdown: 'Detalle por página',
          details: 'Detalles',
          analyzedAt: 'Analizado en',
        }
      : {
          title: 'High Performance Analyzer - Lighthouse++',
          subtitle: 'Executive performance report focused on actions',
          healthScore: 'Average score',
          pagesAnalyzed: 'Pages analyzed',
          findings: 'Findings',
          noData: 'No data',
          causes: 'Root causes',
          possibleFix: 'Possible fix',
          opportunities: 'Opportunities',
          metrics: 'Metrics',
          screenshot: 'Reference screenshot',
          previousRun: 'Previous run',
          comparisonStatus: 'Status',
          improved: 'Improved',
          regressed: 'Regressed',
          stable: 'Stable',
          newlyDiscovered: 'New URL',
          delta: 'Delta',
          priority: 'Priority',
          topActions: 'Top recommended actions',
          pageBreakdown: 'Per-page breakdown',
          details: 'Details',
          analyzedAt: 'Analyzed at',
        }

  const averageScore = payload.results.length
    ? Number(
        (
          payload.results.reduce((sum, item) => sum + item.performanceScore, 0) /
          payload.results.length
        ).toFixed(2),
      )
    : 0
  const findings = payload.results.reduce((sum, item) => sum + item.issues.length, 0)

  const topActions = payload.results
    .flatMap((item) => item.suggestions)
    .filter((value, index, source) => source.indexOf(value) === index)
    .slice(0, 3)

  const rows = payload.results
    .map((result) => {
      const comparisonStatus =
        result.comparison?.status === 'improved'
          ? labels.improved
          : result.comparison?.status === 'regressed'
            ? labels.regressed
            : result.comparison?.status === 'stable'
              ? labels.stable
              : labels.newlyDiscovered

      return `
      <section class="card">
        <div class="card-head">
          <h2>${result.pageUrl}</h2>
          <span class="status ${result.comparison?.status ?? 'new'}">${comparisonStatus}</span>
        </div>
        <div class="kpis">
          <div class="kpi"><span>Score</span><b>${result.performanceScore}</b></div>
          <div class="kpi"><span>FCP</span><b>${result.firstContentfulPaintMs ?? 'N/A'} ms</b></div>
          <div class="kpi"><span>LCP</span><b>${result.largestContentfulPaintMs ?? 'N/A'} ms</b></div>
          <div class="kpi"><span>TTI</span><b>${result.timeToInteractiveMs ?? 'N/A'} ms</b></div>
        </div>
        <div class="quick-list">
          <p><b>${labels.comparisonStatus}:</b> ${comparisonStatus}</p>
          <p><b>${labels.previousRun}:</b> ${result.comparison?.previousAnalyzedAt ?? labels.noData}</p>
          <p><b>Score ${labels.delta}:</b> ${result.comparison?.deltas.performanceScore ?? labels.noData}</p>
          <p><b>LCP ${labels.delta}:</b> ${result.comparison?.deltas.largestContentfulPaintMs ?? labels.noData} ms</p>
          <p><b>Req p95 ${labels.delta}:</b> ${result.comparison?.deltas.callTimeP95Ms ?? labels.noData} ms</p>
        </div>
        <details>
          <summary>${labels.details}</summary>
          <h3>${labels.metrics}</h3>
          <ul>
            <li>Payload: <b>${result.totalByteWeightKb} KB</b></li>
            <li>Images: <b>${result.imageBytesKb} KB</b></li>
            <li>Video/Media: <b>${result.videoBytesKb} KB</b></li>
            <li>Calls avg: <b>${result.callTimeAvgMs ?? 'N/A'} ms</b></li>
            <li>Calls p95: <b>${result.callTimeP95Ms ?? 'N/A'} ms</b></li>
            <li>Failure rate: <b>${result.callsFailedRate ?? 'N/A'}%</b></li>
          </ul>
          <h3>${labels.causes}</h3>
          <ul>
            ${
              result.rootCauses.length
                ? result.rootCauses
                    .map(
                      (item) =>
                        `<li><b>${item.cause}</b> (${labels.priority}: ${item.impact})<br />${item.evidence}<br /><b>${labels.possibleFix}:</b> ${item.possibleFix}</li>`,
                    )
                    .join('')
                : `<li>${labels.noData}</li>`
            }
          </ul>
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
        </details>
      </section>
    `
    })
    .join('')

  return `
<!doctype html>
<html lang="${payload.language}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Performance Report</title>
    <style>
      body { font-family: Inter, Arial, sans-serif; margin: 24px; background: #0f172a; color: #e2e8f0; line-height: 1.45; }
      h1 { margin-bottom: 4px; }
      h2 { margin: 0; font-size: 18px; word-break: break-word; }
      h3 { margin-bottom: 8px; margin-top: 16px; font-size: 14px; color: #dbe7ff; }
      .meta { color: #9eb2d7; margin-bottom: 14px; }
      .hero { background: #111c35; border: 1px solid #1f2f53; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
      .hero-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
      .hero-item { background: #0f1830; border: 1px solid #253c68; border-radius: 10px; padding: 10px; }
      .hero-item span { color: #9bb6e8; display: block; font-size: 12px; }
      .hero-item b { font-size: 20px; }
      .actions { margin-top: 12px; background: #0f1830; border: 1px solid #253c68; border-radius: 10px; padding: 10px 12px; }
      .actions h3 { margin-top: 0; }
      .actions ol { margin: 6px 0 0 20px; padding: 0; }
      .card { background: #19253c; border-radius: 12px; padding: 14px; margin-bottom: 12px; border: 1px solid #2d446f; }
      .card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
      .status { display: inline-block; padding: 3px 8px; border-radius: 999px; font-weight: 600; }
      .status.improved { background: #163126; color: #a6ebc8; border: 1px solid #2d6a4f; }
      .status.regressed { background: #3a1520; color: #ffb6c4; border: 1px solid #6d2638; }
      .status.stable { background: #1b2941; color: #bfd3fb; border: 1px solid #365890; }
      .status.new { background: #312311; color: #ffe3ae; border: 1px solid #705324; }
      .kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-bottom: 10px; }
      .kpi { background: #0f172a; border: 1px solid #2d446f; border-radius: 8px; padding: 8px; }
      .kpi span { display: block; color: #9bb0d8; font-size: 12px; }
      .kpi b { font-size: 16px; }
      .quick-list { color: #bdd0f5; display: grid; gap: 6px; margin-bottom: 6px; }
      .quick-list p { margin: 0; }
      details { margin-top: 8px; }
      summary { cursor: pointer; color: #7fc8ff; font-weight: 600; }
      ul { padding-left: 18px; }
      li { margin-bottom: 8px; }
      .shot { width: 100%; max-width: 860px; border-radius: 8px; border: 1px solid #2d446f; }
      @media (max-width: 960px) { .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } .hero-grid { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <h1>${labels.title}</h1>
    <p class="meta">${labels.subtitle}</p>
    <div class="hero">
      <p class="meta">Base URL: ${payload.baseUrl} | ${labels.analyzedAt}: ${payload.analyzedAt}</p>
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
          <span>${labels.findings}</span>
          <b>${findings}</b>
        </div>
      </div>
      <div class="actions">
        <h3>${labels.topActions}</h3>
        ${
          topActions.length
            ? `<ol>${topActions.map((item) => `<li>${item}</li>`).join('')}</ol>`
            : `<p>${labels.noData}</p>`
        }
      </div>
    </div>
    <p class="meta"><b>${labels.pageBreakdown}</b></p>
    ${rows}
  </body>
</html>
`
}

export const analyzeWebsite = async (request: AnalyzeRequest): Promise<AnalyzeResponse> => {
  const discoveredUrls =
    request.includeDiscoveredUrls === false
      ? [normalizeUrl(request.url)]
      : await discoverUrls(request)
  const analyzedAt = new Date().toISOString()
  const reportId = getReportIdFromDate(new Date(analyzedAt))
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
    analyzedAt,
    results: comparedResults,
    htmlReportPath,
    previousReportId: previousRun?.reportId ?? null,
  }

  const html = buildHtmlReport(payload)
  await fs.writeFile(path.join(REPORTS_DIR, htmlFileName), html, 'utf-8')
  await cleanupOldReports()
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
