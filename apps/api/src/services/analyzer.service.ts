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
  const performanceThreshold = 0.8
  const fcpThresholdMs = 1800
  const lcpThresholdMs = 2500
  const pageWeightThresholdKb = 2048
  const avgCallThresholdMs = 800
  const failureRateThresholdPercent = 1

  if (lighthouseResult.performanceScore < performanceThreshold) {
    issues.push(
      lang === 'es'
        ? `Performance score bajo: actual ${lighthouseResult.performanceScore}, esperado >= ${performanceThreshold}.`
        : `Low performance score: current ${lighthouseResult.performanceScore}, expected >= ${performanceThreshold}.`,
    )
    suggestions.add(t(lang, 'reduceJs'))
    rootCauses.push({
      cause:
        lang === 'es'
          ? 'La página carga demasiado código al inicio'
          : 'The page loads too much code upfront',
      evidence:
        lang === 'es'
          ? `El score de rendimiento fue ${lighthouseResult.performanceScore}.`
          : `The performance score was ${lighthouseResult.performanceScore}.`,
      impact: 'high',
      possibleFix:
        lang === 'es'
          ? 'Carga primero lo esencial y difiere scripts no críticos.'
          : 'Load only essentials first and defer non-critical scripts.',
    })
  }
  if ((lighthouseResult.firstContentfulPaintMs ?? 0) > fcpThresholdMs) {
    issues.push(
      lang === 'es'
        ? `FCP lento: actual ${lighthouseResult.firstContentfulPaintMs ?? 'N/A'} ms, esperado <= ${fcpThresholdMs} ms.`
        : `Slow FCP: current ${lighthouseResult.firstContentfulPaintMs ?? 'N/A'} ms, expected <= ${fcpThresholdMs} ms.`,
    )
    suggestions.add(t(lang, 'cacheAssets'))
    rootCauses.push({
      cause:
        lang === 'es'
          ? 'El primer contenido tarda en aparecer'
          : 'The first content appears too late',
      evidence:
        lang === 'es'
          ? `FCP: ${lighthouseResult.firstContentfulPaintMs} ms (objetivo: <= 1800 ms).`
          : `FCP: ${lighthouseResult.firstContentfulPaintMs} ms (target: <= 1800 ms).`,
      impact: 'medium',
      possibleFix:
        lang === 'es'
          ? 'Reduce recursos bloqueantes y prioriza CSS crítico.'
          : 'Reduce render-blocking resources and prioritize critical CSS.',
    })
  }
  if ((lighthouseResult.largestContentfulPaintMs ?? 0) > lcpThresholdMs) {
    issues.push(
      lang === 'es'
        ? `LCP lento: actual ${lighthouseResult.largestContentfulPaintMs ?? 'N/A'} ms, esperado <= ${lcpThresholdMs} ms.`
        : `Slow LCP: current ${lighthouseResult.largestContentfulPaintMs ?? 'N/A'} ms, expected <= ${lcpThresholdMs} ms.`,
    )
    suggestions.add(t(lang, 'improveImages'))
    rootCauses.push({
      cause:
        lang === 'es'
          ? 'El contenido principal tarda en mostrarse'
          : 'The main content loads too late',
      evidence:
        lang === 'es'
          ? `LCP: ${lighthouseResult.largestContentfulPaintMs} ms (objetivo: <= 2500 ms).`
          : `LCP: ${lighthouseResult.largestContentfulPaintMs} ms (target: <= 2500 ms).`,
      impact: 'high',
      possibleFix:
        lang === 'es'
          ? 'Optimiza el hero principal y retrasa recursos secundarios.'
          : 'Optimize the main hero content and delay secondary resources.',
    })
  }
  if (lighthouseResult.totalByteWeightKb > pageWeightThresholdKb) {
    issues.push(
      lang === 'es'
        ? `Página pesada: actual ${lighthouseResult.totalByteWeightKb} KB, esperado <= ${pageWeightThresholdKb} KB.`
        : `Heavy page payload: current ${lighthouseResult.totalByteWeightKb} KB, expected <= ${pageWeightThresholdKb} KB.`,
    )
    suggestions.add(t(lang, 'improveImages'))
    rootCauses.push({
      cause: lang === 'es' ? 'La página pesa demasiado' : 'The page payload is too heavy',
      evidence:
        lang === 'es'
          ? `Peso transferido: ${lighthouseResult.totalByteWeightKb} KB (objetivo: <= 2048 KB).`
          : `Transferred size: ${lighthouseResult.totalByteWeightKb} KB (target: <= 2048 KB).`,
      impact: 'high',
      possibleFix:
        lang === 'es'
          ? 'Comprime imágenes y elimina archivos que no aportan valor.'
          : 'Compress images and remove files that do not add value.',
    })
  }
  if (typeof avg === 'number' && avg > avgCallThresholdMs) {
    issues.push(
      lang === 'es'
        ? `Llamadas API lentas: promedio actual ${avg.toFixed(2)} ms, esperado <= ${avgCallThresholdMs} ms.`
        : `Slow API calls: current average ${avg.toFixed(2)} ms, expected <= ${avgCallThresholdMs} ms.`,
    )
    suggestions.add(t(lang, 'optimizeBackend'))
    rootCauses.push({
      cause: lang === 'es' ? 'El servidor responde lento' : 'The server responds too slowly',
      evidence:
        lang === 'es'
          ? `Tiempo promedio de respuesta: ${avg.toFixed(2)} ms (objetivo: <= 800 ms).`
          : `Average response time: ${avg.toFixed(2)} ms (target: <= 800 ms).`,
      impact: 'medium',
      possibleFix:
        lang === 'es'
          ? 'Optimiza consultas, agrega caché y revisa endpoints lentos.'
          : 'Optimize queries, add caching, and review slow endpoints.',
    })
  }
  if (typeof failRate === 'number' && failRate > 0.01) {
    issues.push(
      lang === 'es'
        ? `Tasa de error alta: actual ${(failRate * 100).toFixed(2)}%, esperado <= ${failureRateThresholdPercent}%.`
        : `High error rate: current ${(failRate * 100).toFixed(2)}%, expected <= ${failureRateThresholdPercent}%.`,
    )
    suggestions.add(t(lang, 'optimizeBackend'))
    rootCauses.push({
      cause:
        lang === 'es' ? 'Demasiadas solicitudes están fallando' : 'Too many requests are failing',
      evidence:
        lang === 'es'
          ? `Error rate: ${(failRate * 100).toFixed(2)}% (objetivo: <= 1%).`
          : `Error rate: ${(failRate * 100).toFixed(2)}% (target: <= 1%).`,
      impact: 'high',
      possibleFix:
        lang === 'es'
          ? 'Revisa códigos de error, timeouts y endpoints inestables.'
          : 'Review status codes, timeouts, and unstable endpoints.',
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
  const thresholds = {
    performance: 0.8,
    fcpMs: 1800,
    lcpMs: 2500,
    payloadKb: 2048,
    avgCallMs: 800,
    failureRatePercent: 1,
  }

  const labelsByLanguage: Record<
    LanguageCode,
    {
      title: string
      subtitle: string
      healthScore: string
      pagesAnalyzed: string
      findings: string
      noData: string
      causes: string
      possibleFix: string
      opportunities: string
      metrics: string
      screenshot: string
      previousRun: string
      comparisonStatus: string
      improved: string
      regressed: string
      stable: string
      newlyDiscovered: string
      delta: string
      priority: string
      topActions: string
      pageBreakdown: string
      details: string
      analyzedAt: string
      whyItMatters: string
      whatToDo: string
      impactHigh: string
      impactMedium: string
      impactLow: string
      scoreOverview: string
      scorePercent: string
      severitySplit: string
      language: string
      rawScore: string
      payloadLabel: string
      imagesLabel: string
      mediaLabel: string
      callsAvgLabel: string
      callsP95Label: string
      failureRateLabel: string
      baseUrlLabel: string
      opportunityCurrent: string
      opportunityExpected: string
      opportunityStatus: string
      opportunityGood: string
      opportunityNeedsWork: string
      opportunityCritical: string
      executiveSummary: string
      overallStatus: string
      targetLabel: string
      gapLabel: string
      onTarget: string
      focusFirst: string
      statusHealthy: string
      statusAttention: string
      statusCritical: string
    }
  > = {
    es: {
      title: 'High Performance Analyzer Report',
      subtitle: 'Reporte ejecutivo de performance con foco en acciones',
      healthScore: 'Score promedio',
      pagesAnalyzed: 'Paginas analizadas',
      findings: 'Hallazgos',
      noData: 'Sin datos',
      causes: 'Causas raiz',
      possibleFix: 'Posible solucion',
      opportunities: 'Oportunidades',
      metrics: 'Metricas',
      screenshot: 'Captura de referencia',
      previousRun: 'Ejecucion previa',
      comparisonStatus: 'Estado',
      improved: 'Mejoro',
      regressed: 'Empeoro',
      stable: 'Estable',
      newlyDiscovered: 'Nueva URL',
      delta: 'Delta',
      priority: 'Prioridad',
      topActions: 'Top acciones recomendadas',
      pageBreakdown: 'Detalle por pagina',
      details: 'Detalles',
      analyzedAt: 'Analizado en',
      whyItMatters: 'Por que importa',
      whatToDo: 'Que hacer',
      impactHigh: 'Alta',
      impactMedium: 'Media',
      impactLow: 'Baja',
      scoreOverview: 'Score general',
      scorePercent: 'Puntaje',
      severitySplit: 'Distribucion de severidad',
      language: 'Idioma',
      rawScore: 'Score crudo',
      payloadLabel: 'Payload',
      imagesLabel: 'Imagenes',
      mediaLabel: 'Video/Media',
      callsAvgLabel: 'Llamadas promedio',
      callsP95Label: 'Llamadas p95',
      failureRateLabel: 'Tasa de fallas',
      baseUrlLabel: 'URL base',
      opportunityCurrent: 'Actual',
      opportunityExpected: 'Esperado',
      opportunityStatus: 'Estado',
      opportunityGood: 'Bien',
      opportunityNeedsWork: 'Mejorable',
      opportunityCritical: 'Critico',
      executiveSummary: 'Resumen ejecutivo',
      overallStatus: 'Estado general',
      targetLabel: 'Objetivo',
      gapLabel: 'Brecha',
      onTarget: 'En objetivo',
      focusFirst: 'Priorizar',
      statusHealthy: 'Saludable',
      statusAttention: 'Atencion',
      statusCritical: 'Critico',
    },
    en: {
      title: 'High Performance Analyzer Report',
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
      whyItMatters: 'Why it matters',
      whatToDo: 'What to do',
      impactHigh: 'High',
      impactMedium: 'Medium',
      impactLow: 'Low',
      scoreOverview: 'Overall score',
      scorePercent: 'Score',
      severitySplit: 'Severity split',
      language: 'Language',
      rawScore: 'Raw score',
      payloadLabel: 'Payload',
      imagesLabel: 'Images',
      mediaLabel: 'Video/Media',
      callsAvgLabel: 'Calls avg',
      callsP95Label: 'Calls p95',
      failureRateLabel: 'Failure rate',
      baseUrlLabel: 'Base URL',
      opportunityCurrent: 'Current',
      opportunityExpected: 'Expected',
      opportunityStatus: 'Status',
      opportunityGood: 'Good',
      opportunityNeedsWork: 'Needs work',
      opportunityCritical: 'Critical',
      executiveSummary: 'Executive summary',
      overallStatus: 'Overall status',
      targetLabel: 'Target',
      gapLabel: 'Gap',
      onTarget: 'On target',
      focusFirst: 'Focus first',
      statusHealthy: 'Healthy',
      statusAttention: 'Needs attention',
      statusCritical: 'Critical',
    },
  }

  const getLocalizedContent = (
    result: AnalyzeResponse['results'][number],
    lang: LanguageCode,
  ): {
    actions: string[]
    rootCauses: UrlInsights['rootCauses']
    issueCount: number
  } => {
    const actions = new Set<string>()
    const rootCauses: UrlInsights['rootCauses'] = []
    let issueCount = 0

    if (result.performanceScore < thresholds.performance) {
      issueCount += 1
      actions.add(
        lang === 'es'
          ? 'Carga primero lo esencial y difiere scripts no criticos.'
          : 'Load only essentials first and defer non-critical scripts.',
      )
      rootCauses.push({
        cause:
          lang === 'es'
            ? 'La pagina carga demasiado codigo al inicio'
            : 'The page loads too much code upfront',
        evidence:
          lang === 'es'
            ? `Performance score bajo: actual ${result.performanceScore}, esperado >= ${thresholds.performance}.`
            : `Low performance score: current ${result.performanceScore}, expected >= ${thresholds.performance}.`,
        impact: 'high',
        possibleFix:
          lang === 'es'
            ? 'Prioriza recursos criticos y retrasa codigo secundario.'
            : 'Prioritize critical resources and delay secondary code.',
      })
    }

    if ((result.firstContentfulPaintMs ?? 0) > thresholds.fcpMs) {
      issueCount += 1
      actions.add(
        lang === 'es'
          ? 'Reduce recursos bloqueantes y prioriza CSS critico.'
          : 'Reduce render-blocking resources and prioritize critical CSS.',
      )
      rootCauses.push({
        cause:
          lang === 'es'
            ? 'El primer contenido tarda en aparecer'
            : 'The first content appears too late',
        evidence:
          lang === 'es'
            ? `FCP lento: actual ${result.firstContentfulPaintMs ?? 'N/A'} ms, esperado <= ${thresholds.fcpMs} ms.`
            : `Slow FCP: current ${result.firstContentfulPaintMs ?? 'N/A'} ms, expected <= ${thresholds.fcpMs} ms.`,
        impact: 'medium',
        possibleFix:
          lang === 'es'
            ? 'Optimiza CSS/fuentes iniciales para mostrar contenido antes.'
            : 'Optimize initial CSS/fonts to show content sooner.',
      })
    }

    if ((result.largestContentfulPaintMs ?? 0) > thresholds.lcpMs) {
      issueCount += 1
      actions.add(
        lang === 'es'
          ? 'Optimiza el hero principal y retrasa recursos secundarios.'
          : 'Optimize the main hero content and delay secondary resources.',
      )
      rootCauses.push({
        cause:
          lang === 'es'
            ? 'El contenido principal tarda en mostrarse'
            : 'The main content loads too late',
        evidence:
          lang === 'es'
            ? `LCP lento: actual ${result.largestContentfulPaintMs ?? 'N/A'} ms, esperado <= ${thresholds.lcpMs} ms.`
            : `Slow LCP: current ${result.largestContentfulPaintMs ?? 'N/A'} ms, expected <= ${thresholds.lcpMs} ms.`,
        impact: 'high',
        possibleFix:
          lang === 'es'
            ? 'Reduce peso del contenido principal y precarga recursos clave.'
            : 'Reduce main-content weight and preload key resources.',
      })
    }

    if (result.totalByteWeightKb > thresholds.payloadKb) {
      issueCount += 1
      actions.add(
        lang === 'es'
          ? 'Comprime imagenes y elimina archivos que no aportan valor.'
          : 'Compress images and remove files that do not add value.',
      )
      rootCauses.push({
        cause: lang === 'es' ? 'La pagina pesa demasiado' : 'The page payload is too heavy',
        evidence:
          lang === 'es'
            ? `Pagina pesada: actual ${result.totalByteWeightKb} KB, esperado <= ${thresholds.payloadKb} KB.`
            : `Heavy page payload: current ${result.totalByteWeightKb} KB, expected <= ${thresholds.payloadKb} KB.`,
        impact: 'high',
        possibleFix:
          lang === 'es'
            ? 'Usa compresion y elimina recursos innecesarios.'
            : 'Use compression and remove unnecessary resources.',
      })
    }

    if (typeof result.callTimeAvgMs === 'number' && result.callTimeAvgMs > thresholds.avgCallMs) {
      issueCount += 1
      actions.add(
        lang === 'es'
          ? 'Optimiza consultas, agrega cache y revisa endpoints lentos.'
          : 'Optimize queries, add caching, and review slow endpoints.',
      )
      rootCauses.push({
        cause: lang === 'es' ? 'El servidor responde lento' : 'The server responds too slowly',
        evidence:
          lang === 'es'
            ? `Llamadas API lentas: promedio actual ${result.callTimeAvgMs.toFixed(2)} ms, esperado <= ${thresholds.avgCallMs} ms.`
            : `Slow API calls: current average ${result.callTimeAvgMs.toFixed(2)} ms, expected <= ${thresholds.avgCallMs} ms.`,
        impact: 'medium',
        possibleFix:
          lang === 'es'
            ? 'Revisa base de datos, cache y endpoints con mayor latencia.'
            : 'Review database, cache, and highest-latency endpoints.',
      })
    }

    if (
      typeof result.callsFailedRate === 'number' &&
      result.callsFailedRate > thresholds.failureRatePercent
    ) {
      issueCount += 1
      actions.add(
        lang === 'es'
          ? 'Revisa codigos de error, timeouts y endpoints inestables.'
          : 'Review status codes, timeouts, and unstable endpoints.',
      )
      rootCauses.push({
        cause:
          lang === 'es' ? 'Demasiadas solicitudes estan fallando' : 'Too many requests are failing',
        evidence:
          lang === 'es'
            ? `Tasa de error alta: actual ${result.callsFailedRate.toFixed(2)}%, esperado <= ${thresholds.failureRatePercent}%.`
            : `High error rate: current ${result.callsFailedRate.toFixed(2)}%, expected <= ${thresholds.failureRatePercent}%.`,
        impact: 'high',
        possibleFix:
          lang === 'es'
            ? 'Valida retries, timeouts y manejo de errores por endpoint.'
            : 'Validate retries, timeouts, and per-endpoint error handling.',
      })
    }

    return { actions: [...actions], rootCauses, issueCount }
  }

  const averageScore = payload.results.length
    ? Number(
        (
          payload.results.reduce((sum, item) => sum + item.performanceScore, 0) /
          payload.results.length
        ).toFixed(2),
      )
    : 0

  const averageScorePercent = Math.round(averageScore * 100)
  const overallScoreClass =
    averageScorePercent >= 90 ? 'good' : averageScorePercent >= 50 ? 'average' : 'poor'

  const getOpportunityTarget = (title: string, lang: LanguageCode): string => {
    const normalized = title.toLowerCase()
    if (normalized.includes('first contentful paint')) return '<= 1.8 s'
    if (normalized.includes('largest contentful paint')) return '<= 2.5 s'
    if (normalized.includes('speed index')) return '<= 3.4 s'
    if (normalized.includes('total blocking time')) return '<= 200 ms'
    if (normalized.includes('max potential first input delay')) return '<= 100 ms'
    if (normalized.includes('cumulative layout shift')) return '<= 0.10'
    return lang === 'es' ? 'Score >= 0.90' : 'Score >= 0.90'
  }

  const getOpportunityThreshold = (
    title: string,
  ): { max: number; unit: 's' | 'ms' | 'value' } | null => {
    const normalized = title.toLowerCase()
    if (normalized.includes('first contentful paint')) return { max: 1.8, unit: 's' }
    if (normalized.includes('largest contentful paint')) return { max: 2.5, unit: 's' }
    if (normalized.includes('speed index')) return { max: 3.4, unit: 's' }
    if (normalized.includes('total blocking time')) return { max: 200, unit: 'ms' }
    if (normalized.includes('max potential first input delay')) return { max: 100, unit: 'ms' }
    if (normalized.includes('cumulative layout shift')) return { max: 0.1, unit: 'value' }
    return null
  }

  const getOpportunityStatusClass = (
    title: string,
    detail: string,
    score: number | null,
  ): 'good' | 'average' | 'poor' => {
    const threshold = getOpportunityThreshold(title)
    if (threshold) {
      const currentMatch = detail.match(/(\d+(?:\.\d+)?)/)
      if (currentMatch) {
        const currentValue = Number(currentMatch[1])
        return currentValue <= threshold.max ? 'good' : 'poor'
      }
    }
    if (typeof score === 'number') return score >= 0.9 ? 'good' : score >= 0.5 ? 'average' : 'poor'
    return 'average'
  }

  const formatMetricValue = (value: number | null, unit: 'score' | 'ms' | 'kb'): string => {
    if (value === null) return 'N/A'
    if (unit === 'score') return value.toFixed(2)
    if (unit === 'ms')
      return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`
    return value >= 1024 ? `${(value / 1024).toFixed(2)} MB` : `${value.toFixed(2)} KB`
  }

  const getMetricStatus = (
    current: number | null,
    expected: number,
    betterDirection: 'higher' | 'lower',
  ): 'good' | 'average' | 'poor' => {
    if (typeof current !== 'number') return 'average'
    if (betterDirection === 'higher') {
      if (current >= expected) return 'good'
      if (current >= expected * 0.75) return 'average'
      return 'poor'
    }
    if (current <= expected) return 'good'
    if (current <= expected * 1.5) return 'average'
    return 'poor'
  }

  const formatGap = (
    current: number | null,
    expected: number,
    betterDirection: 'higher' | 'lower',
    labels: (typeof labelsByLanguage)[LanguageCode],
  ): string => {
    if (typeof current !== 'number') return 'N/A'
    const ratio =
      betterDirection === 'higher'
        ? (current - expected) / expected
        : (current - expected) / expected
    if (
      (betterDirection === 'higher' && current >= expected) ||
      (betterDirection === 'lower' && current <= expected)
    ) {
      return labels.onTarget
    }
    return `${ratio > 0 ? '+' : ''}${Math.round(ratio * 100)}%`
  }

  const buildLanguageSection = (lang: LanguageCode): string => {
    const labels = labelsByLanguage[lang]
    const localizedResults = payload.results.map((result) => ({
      result,
      localized: getLocalizedContent(result, lang),
    }))

    const findings = localizedResults.reduce((sum, item) => sum + item.localized.issueCount, 0)
    const severity = localizedResults.reduce(
      (acc, item) => {
        for (const cause of item.localized.rootCauses) {
          if (cause.impact === 'high') acc.high += 1
          else if (cause.impact === 'medium') acc.medium += 1
          else acc.low += 1
        }
        return acc
      },
      { high: 0, medium: 0, low: 0 },
    )

    const severityTotal = Math.max(1, severity.high + severity.medium + severity.low)
    const highPercent = Number(((severity.high / severityTotal) * 100).toFixed(2))
    const mediumPercent = Number(((severity.medium / severityTotal) * 100).toFixed(2))

    const topActions = localizedResults
      .flatMap((item) => item.localized.actions)
      .filter((value, index, source) => source.indexOf(value) === index)
      .slice(0, 3)

    const rows = localizedResults
      .map(({ result, localized }) => {
        const comparisonStatus =
          result.comparison?.status === 'improved'
            ? labels.improved
            : result.comparison?.status === 'regressed'
              ? labels.regressed
              : result.comparison?.status === 'stable'
                ? labels.stable
                : labels.newlyDiscovered

        const summaryMetrics = [
          {
            title: labels.scorePercent,
            current: result.performanceScore,
            expected: thresholds.performance,
            unit: 'score' as const,
            direction: 'higher' as const,
          },
          {
            title: 'FCP',
            current: result.firstContentfulPaintMs,
            expected: thresholds.fcpMs,
            unit: 'ms' as const,
            direction: 'lower' as const,
          },
          {
            title: 'LCP',
            current: result.largestContentfulPaintMs,
            expected: thresholds.lcpMs,
            unit: 'ms' as const,
            direction: 'lower' as const,
          },
          {
            title: labels.payloadLabel,
            current: result.totalByteWeightKb,
            expected: thresholds.payloadKb,
            unit: 'kb' as const,
            direction: 'lower' as const,
          },
        ]

        const summaryWithStatus = summaryMetrics.map((metric) => ({
          ...metric,
          status: getMetricStatus(metric.current, metric.expected, metric.direction),
        }))

        const criticalCount = summaryWithStatus.filter((metric) => metric.status === 'poor').length
        const warningCount = summaryWithStatus.filter(
          (metric) => metric.status === 'average',
        ).length

        const overallState =
          criticalCount > 0
            ? { key: 'poor', label: labels.statusCritical }
            : warningCount > 0
              ? { key: 'average', label: labels.statusAttention }
              : { key: 'good', label: labels.statusHealthy }

        const topGaps = summaryWithStatus
          .filter((metric) => metric.status !== 'good')
          .map((metric) => ({
            title: metric.title,
            gap: formatGap(metric.current, metric.expected, metric.direction, labels),
          }))
          .slice(0, 2)

        return `
        <section class="card">
          <div class="card-head">
            <h2>${result.pageUrl}</h2>
            <span class="status ${result.comparison?.status ?? 'new'}">${comparisonStatus}</span>
          </div>
          <div class="score-row">
            <span>${labels.scorePercent}</span>
            <div class="score-bar">
              <div class="score-fill ${
                result.performanceScore >= 0.9
                  ? 'good'
                  : result.performanceScore >= 0.5
                    ? 'average'
                    : 'poor'
              }" style="width: ${Math.round(result.performanceScore * 100)}%"></div>
            </div>
            <b>${Math.round(result.performanceScore * 100)}</b>
          </div>
          <div class="kpis">
            <div class="kpi"><span>${labels.rawScore}</span><b>${result.performanceScore}</b></div>
            <div class="kpi"><span>FCP</span><b>${result.firstContentfulPaintMs ?? 'N/A'} ms</b></div>
            <div class="kpi"><span>LCP</span><b>${result.largestContentfulPaintMs ?? 'N/A'} ms</b></div>
            <div class="kpi"><span>TTI</span><b>${result.timeToInteractiveMs ?? 'N/A'} ms</b></div>
          </div>
          <div class="exec-block">
            <h3>${labels.executiveSummary}</h3>
            <div class="exec-head">
              <span class="state-badge ${overallState.key}">${labels.overallStatus}: ${overallState.label}</span>
              <span class="muted">${labels.focusFirst}: ${
                topGaps.length
                  ? topGaps.map((metric) => `${metric.title} (${metric.gap})`).join(' | ')
                  : labels.onTarget
              }</span>
            </div>
            <table class="summary-table">
              <thead>
                <tr>
                  <th>${labels.metrics}</th>
                  <th>${labels.opportunityCurrent}</th>
                  <th>${labels.targetLabel}</th>
                  <th>${labels.gapLabel}</th>
                </tr>
              </thead>
              <tbody>
                ${summaryWithStatus
                  .map(
                    (metric) => `<tr>
                      <td>${metric.title}</td>
                      <td>${formatMetricValue(metric.current, metric.unit)}</td>
                      <td>${formatMetricValue(metric.expected, metric.unit)}</td>
                      <td><span class="op-badge ${metric.status}">${formatGap(metric.current, metric.expected, metric.direction, labels)}</span></td>
                    </tr>`,
                  )
                  .join('')}
              </tbody>
            </table>
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
              <li>${labels.payloadLabel}: <b>${result.totalByteWeightKb} KB</b></li>
              <li>${labels.imagesLabel}: <b>${result.imageBytesKb} KB</b></li>
              <li>${labels.mediaLabel}: <b>${result.videoBytesKb} KB</b></li>
              <li>${labels.callsAvgLabel}: <b>${result.callTimeAvgMs ?? 'N/A'} ms</b></li>
              <li>${labels.callsP95Label}: <b>${result.callTimeP95Ms ?? 'N/A'} ms</b></li>
              <li>${labels.failureRateLabel}: <b>${result.callsFailedRate ?? 'N/A'}%</b></li>
            </ul>
            <h3>${labels.causes}</h3>
            <ul>
              ${
                localized.rootCauses.length
                  ? localized.rootCauses
                      .map((item) => {
                        const impactLabel =
                          item.impact === 'high'
                            ? labels.impactHigh
                            : item.impact === 'medium'
                              ? labels.impactMedium
                              : labels.impactLow

                        return `<li><b>${item.cause}</b> (${labels.priority}: ${impactLabel})<br /><span class="muted">${labels.whyItMatters}:</span> ${item.evidence}<br /><span class="muted">${labels.whatToDo}:</span> ${item.possibleFix}</li>`
                      })
                      .join('')
                  : `<li>${labels.noData}</li>`
              }
            </ul>
            <h3>${labels.opportunities}</h3>
            <ul>
              ${
                result.opportunities.length
                  ? result.opportunities
                      .map((item) => {
                        const statusClass = getOpportunityStatusClass(
                          item.title,
                          item.detail,
                          item.score,
                        )
                        const statusLabel =
                          statusClass === 'good'
                            ? labels.opportunityGood
                            : statusClass === 'average'
                              ? labels.opportunityNeedsWork
                              : labels.opportunityCritical
                        const expected = getOpportunityTarget(item.title, lang)

                        return `<li class="opportunity-item">
                          <div class="opportunity-head">
                            <b>${item.title}</b>
                            <span class="op-badge ${statusClass}">${statusLabel}</span>
                          </div>
                          <div class="muted">${labels.opportunityStatus}: ${statusLabel} | ${labels.opportunityCurrent}: ${item.detail} | ${labels.opportunityExpected}: ${expected}</div>
                        </li>`
                      })
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
      <section class="lang-block ${lang === payload.language ? 'active' : ''}" data-lang="${lang}">
        <h1>${labels.title}</h1>
        <p class="meta">${labels.subtitle}</p>
        <div class="hero">
          <p class="meta">${labels.baseUrlLabel}: ${payload.baseUrl} | ${labels.analyzedAt}: ${payload.analyzedAt}</p>
          <div class="overview">
            <div class="score-gauge ${overallScoreClass}" style="--score:${averageScorePercent}; --gauge:${
              overallScoreClass === 'good'
                ? '#16a34a'
                : overallScoreClass === 'average'
                  ? '#f59e0b'
                  : '#dc2626'
            }">
              <div class="inner">
                <div>
                  <b>${averageScorePercent}</b>
                  <span>${labels.scoreOverview}</span>
                </div>
              </div>
            </div>
            <div>
              <h3>${labels.severitySplit}</h3>
              <div class="score-gauge" style="--score:100; --gauge: conic-gradient(#dc2626 0 ${highPercent}%, #f59e0b ${highPercent}% ${highPercent + mediumPercent}%, #16a34a ${highPercent + mediumPercent}% 100%); background: var(--gauge); width: 116px; height: 116px;">
                <div class="inner" style="width: 86px; height: 86px;"><span>${findings}</span></div>
              </div>
              <ul class="legend">
                <li><span class="dot high"></span>${labels.impactHigh}: ${severity.high}</li>
                <li><span class="dot medium"></span>${labels.impactMedium}: ${severity.medium}</li>
                <li><span class="dot low"></span>${labels.impactLow}: ${severity.low}</li>
              </ul>
            </div>
          </div>
          <div class="hero-grid">
            <div class="hero-item">
              <span>${labels.healthScore}</span>
              <b>${averageScorePercent}</b>
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
      </section>
    `
  }

  return `
<!doctype html>
<html lang="${payload.language}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Performance Report</title>
    <style>
      body { font-family: Inter, Arial, sans-serif; margin: 24px; background: #f8fafc; color: #0f172a; line-height: 1.5; }
      h1 { margin-bottom: 4px; color: #0f172a; }
      h2 { margin: 0; font-size: 18px; word-break: break-word; color: #0f172a; }
      h3 { margin-bottom: 8px; margin-top: 16px; font-size: 14px; color: #334155; }
      .meta { color: #475569; margin-bottom: 14px; }
      .language-toggle { display: inline-flex; gap: 6px; margin-bottom: 16px; align-items: center; }
      .language-toggle .label { color: #64748b; font-size: 13px; }
      .language-toggle button { border: 1px solid #cbd5e1; background: #fff; color: #334155; border-radius: 999px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
      .language-toggle button.active { background: #0f172a; color: #fff; border-color: #0f172a; }
      .lang-block { display: none; }
      .lang-block.active { display: block; }
      .hero { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
      .overview { display: grid; grid-template-columns: 160px 1fr; gap: 14px; align-items: center; margin-bottom: 14px; }
      .score-gauge { width: 140px; height: 140px; border-radius: 999px; display: grid; place-items: center; background: conic-gradient(var(--gauge) calc(var(--score) * 1%), #e2e8f0 0); }
      .score-gauge .inner { width: 108px; height: 108px; border-radius: 999px; background: #fff; display: grid; place-items: center; text-align: center; }
      .score-gauge b { font-size: 30px; color: #0f172a; line-height: 1; }
      .score-gauge span { font-size: 12px; color: #64748b; }
      .hero-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
      .hero-item { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px; }
      .hero-item span { color: #64748b; display: block; font-size: 12px; }
      .hero-item b { font-size: 20px; color: #0f172a; }
      .actions { margin-top: 12px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px 12px; }
      .actions h3 { margin-top: 0; }
      .actions ol { margin: 6px 0 0 20px; padding: 0; }
      .card { background: #ffffff; border-radius: 12px; padding: 14px; margin-bottom: 12px; border: 1px solid #e2e8f0; }
      .card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
      .status { display: inline-block; padding: 3px 8px; border-radius: 999px; font-weight: 600; font-size: 12px; }
      .status.improved { background: #ecfdf3; color: #166534; border: 1px solid #bbf7d0; }
      .status.regressed { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
      .status.stable { background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; }
      .status.new { background: #fffbeb; color: #92400e; border: 1px solid #fde68a; }
      .score-row { display: grid; grid-template-columns: 110px 1fr 40px; gap: 8px; align-items: center; margin-bottom: 10px; }
      .score-row span { font-size: 12px; color: #64748b; }
      .score-bar { height: 8px; border-radius: 999px; overflow: hidden; background: #e2e8f0; }
      .score-fill { height: 100%; }
      .score-fill.good { background: #16a34a; }
      .score-fill.average { background: #f59e0b; }
      .score-fill.poor { background: #dc2626; }
      .kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-bottom: 10px; }
      .kpi { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px; }
      .kpi span { display: block; color: #64748b; font-size: 12px; }
      .kpi b { font-size: 16px; color: #0f172a; }
      .exec-block { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px; margin-bottom: 10px; }
      .exec-block h3 { margin: 0 0 8px; }
      .exec-head { display: flex; justify-content: space-between; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
      .state-badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 700; }
      .state-badge.good { background: #ecfdf3; color: #166534; border: 1px solid #bbf7d0; }
      .state-badge.average { background: #fffbeb; color: #92400e; border: 1px solid #fde68a; }
      .state-badge.poor { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
      .summary-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .summary-table th, .summary-table td { padding: 6px 4px; border-bottom: 1px solid #e2e8f0; text-align: left; }
      .summary-table th { color: #475569; font-weight: 600; }
      .quick-list { color: #334155; display: grid; gap: 6px; margin-bottom: 6px; }
      .quick-list p { margin: 0; }
      details { margin-top: 8px; border-top: 1px solid #e2e8f0; padding-top: 8px; }
      summary { cursor: pointer; color: #334155; font-weight: 600; }
      ul { padding-left: 18px; }
      li { margin-bottom: 8px; }
      .legend { display: flex; gap: 12px; flex-wrap: wrap; margin: 6px 0 0; padding: 0; list-style: none; }
      .legend li { display: inline-flex; align-items: center; gap: 6px; color: #475569; font-size: 12px; margin: 0; }
      .dot { width: 10px; height: 10px; border-radius: 999px; display: inline-block; }
      .dot.high { background: #dc2626; }
      .dot.medium { background: #f59e0b; }
      .dot.low { background: #16a34a; }
      .muted { color: #64748b; font-weight: 600; }
      .opportunity-item { margin-bottom: 10px; }
      .opportunity-head { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
      .op-badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; }
      .op-badge.good { background: #ecfdf3; color: #166534; border: 1px solid #bbf7d0; }
      .op-badge.average { background: #fffbeb; color: #92400e; border: 1px solid #fde68a; }
      .op-badge.poor { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
      .shot { width: 100%; max-width: 860px; border-radius: 8px; border: 1px solid #e2e8f0; }
      @media (max-width: 960px) { .overview { grid-template-columns: 1fr; } .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } .hero-grid { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <div class="language-toggle">
      <span class="label">Language</span>
      <button type="button" data-lang-btn="en">EN</button>
      <button type="button" data-lang-btn="es">ES</button>
    </div>
    ${buildLanguageSection('en')}
    ${buildLanguageSection('es')}
    <script>
      const buttons = Array.from(document.querySelectorAll('[data-lang-btn]'))
      const blocks = Array.from(document.querySelectorAll('[data-lang]'))
      const initialLanguage = ${JSON.stringify(payload.language)}
      const setLanguage = (lang) => {
        buttons.forEach((button) => button.classList.toggle('active', button.dataset.langBtn === lang))
        blocks.forEach((block) => block.classList.toggle('active', block.dataset.lang === lang))
      }
      buttons.forEach((button) => button.addEventListener('click', () => setLanguage(button.dataset.langBtn)))
      setLanguage(initialLanguage)
    </script>
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
