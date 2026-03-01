import type { ApiCheckRequest, ApiCheckResult, LanguageCode, UrlInsights } from '@hpa/shared'
import { load } from 'cheerio'
import { t } from './i18n.js'

export const API_CHECK_P95_THRESHOLD_MS = 1200
export const API_CHECK_FAIL_RATE_THRESHOLD_PERCENT = 1

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const DISCOVERABLE_API_PREFIXES = ['/api/', '/graphql', '/rest/']

export interface NormalizedApiCheck {
  name: string
  url: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers: Record<string, string>
  body?: string
}

const normalizeUrl = (rawUrl: string): string => {
  const parsed = new URL(rawUrl)
  parsed.hash = ''
  return parsed.toString()
}

const isDiscoverableApiUrl = (parsedUrl: URL): boolean => {
  const pathname = parsedUrl.pathname.toLowerCase()
  return DISCOVERABLE_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

const normalizeDiscoveredUrl = (rawUrl: string, baseUrl: URL): string | null => {
  try {
    const parsed = new URL(rawUrl, baseUrl)
    if (parsed.origin !== baseUrl.origin) return null
    if (!isDiscoverableApiUrl(parsed)) return null
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return null
  }
}

const inferMethodFromFetchOptions = (rawOptions: string): NormalizedApiCheck['method'] => {
  const methodMatch = rawOptions.match(/method\s*:\s*['"]([A-Za-z]+)['"]/)
  const parsed = methodMatch?.[1]?.toUpperCase()
  if (parsed && HTTP_METHODS.has(parsed)) {
    return parsed as NormalizedApiCheck['method']
  }
  return 'GET'
}

const parseFormMethod = (rawMethod: string | undefined): NormalizedApiCheck['method'] => {
  const parsed = (rawMethod ?? 'GET').toUpperCase()
  if (parsed === 'POST') return 'POST'
  return 'GET'
}

export const discoverApiChecksFromHtml = (
  basePageUrl: string,
  html: string,
  bearerToken?: string,
): NormalizedApiCheck[] => {
  const baseUrl = new URL(basePageUrl)
  const $ = load(html)
  const discovered = new Map<string, NormalizedApiCheck>()
  const headers: Record<string, string> = {}
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`
  }

  const addCheck = (rawUrl: string, method: NormalizedApiCheck['method']): void => {
    const normalizedUrl = normalizeDiscoveredUrl(rawUrl, baseUrl)
    if (!normalizedUrl) return
    const key = `${method} ${normalizedUrl}`
    if (discovered.has(key)) return
    discovered.set(key, {
      name: `Auto API ${discovered.size + 1}`,
      url: normalizedUrl,
      method,
      headers,
    })
  }

  const fetchRegex = /fetch\(\s*['"`]([^'"`]+)['"`]\s*(?:,\s*\{([\s\S]*?)\})?\s*\)/g
  const axiosMethodRegex = /axios\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/gi
  const axiosRequestRegex =
    /axios\(\s*\{[\s\S]*?url\s*:\s*['"`]([^'"`]+)['"`][\s\S]*?(?:method\s*:\s*['"`]([A-Za-z]+)['"`])?[\s\S]*?\}\s*\)/gi

  $('form[action]').each((_, element) => {
    const action = $(element).attr('action')
    if (!action) return
    addCheck(action, parseFormMethod($(element).attr('method')))
  })

  $('[data-api],[data-endpoint]').each((_, element) => {
    const value = $(element).attr('data-api') ?? $(element).attr('data-endpoint')
    if (!value) return
    addCheck(value, 'GET')
  })

  $('script').each((_, element) => {
    const script = $(element).html() ?? ''
    if (!script) return

    for (const match of script.matchAll(fetchRegex)) {
      const rawUrl = match[1]
      if (!rawUrl) continue
      const method = inferMethodFromFetchOptions(match[2] ?? '')
      addCheck(rawUrl, method)
    }

    for (const match of script.matchAll(axiosMethodRegex)) {
      const rawMethod = match[1]
      const rawUrl = match[2]
      if (!rawMethod || !rawUrl) continue
      const method = rawMethod.toUpperCase()
      if (!HTTP_METHODS.has(method)) continue
      addCheck(rawUrl, method as NormalizedApiCheck['method'])
    }

    for (const match of script.matchAll(axiosRequestRegex)) {
      const rawUrl = match[1]
      if (!rawUrl) continue
      const parsedMethod = (match[2] ?? 'GET').toUpperCase()
      const method = HTTP_METHODS.has(parsedMethod)
        ? (parsedMethod as NormalizedApiCheck['method'])
        : 'GET'
      addCheck(rawUrl, method)
    }
  })

  return [...discovered.values()].slice(0, 20)
}

export const discoverApiChecksFromPage = async (
  pageUrl: string,
  bearerToken?: string,
): Promise<NormalizedApiCheck[]> => {
  const headers: HeadersInit = bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}
  try {
    const response = await fetch(pageUrl, {
      headers,
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) return []
    const html = await response.text()
    return discoverApiChecksFromHtml(pageUrl, html, bearerToken)
  } catch {
    return []
  }
}

export const mergeApiChecks = (
  discoveredChecks: NormalizedApiCheck[],
  userChecks: NormalizedApiCheck[],
): NormalizedApiCheck[] => {
  const merged = new Map<string, NormalizedApiCheck>()
  for (const check of [...discoveredChecks, ...userChecks]) {
    const key = `${check.method} ${check.url}`
    if (!merged.has(key)) merged.set(key, check)
  }
  return [...merged.values()].slice(0, 50)
}

export const normalizeApiChecks = (
  checks: ApiCheckRequest[] | undefined,
  bearerToken?: string,
): NormalizedApiCheck[] => {
  if (!Array.isArray(checks) || checks.length === 0) return []

  return checks
    .map((item, index) => {
      const normalizedMethod = (item.method ?? 'GET').toUpperCase()
      if (!HTTP_METHODS.has(normalizedMethod)) {
        throw new Error(`Invalid API check method at index ${index}.`)
      }

      const headers = { ...(item.headers ?? {}) }
      if (bearerToken && !headers.Authorization) {
        headers.Authorization = `Bearer ${bearerToken}`
      }

      return {
        name: item.name?.trim() || `API ${index + 1}`,
        url: normalizeUrl(item.url),
        method: normalizedMethod as NormalizedApiCheck['method'],
        headers,
        body: item.body,
      }
    })
    .slice(0, 50)
}

const numberOrNull = (value: number | undefined): number | null =>
  typeof value === 'number' ? Number(value.toFixed(2)) : null

export const mapApiCheckMetrics = (
  checks: NormalizedApiCheck[],
  metrics: Record<string, { avg?: number; 'p(95)'?: number; rate?: number }> | undefined,
): ApiCheckResult[] =>
  checks.map((check, index) => {
    const durationMetric = metrics?.[`api_check_${index}_duration`]
    const failedMetric = metrics?.[`api_check_${index}_failed`]
    const avg = numberOrNull(durationMetric?.avg)
    const p95 = numberOrNull(durationMetric?.['p(95)'])
    const failRate =
      typeof failedMetric?.rate === 'number' ? Number((failedMetric.rate * 100).toFixed(2)) : null
    const status =
      (p95 !== null && p95 > API_CHECK_P95_THRESHOLD_MS) ||
      (failRate !== null && failRate > API_CHECK_FAIL_RATE_THRESHOLD_PERCENT)
        ? 'fail'
        : 'pass'

    return {
      name: check.name,
      url: check.url,
      method: check.method,
      callTimeAvgMs: avg,
      callTimeP95Ms: p95,
      callsFailedRate: failRate,
      status,
    }
  })

export const buildApiCheckFindings = (
  lang: LanguageCode,
  apiChecks: ApiCheckResult[],
): {
  issues: string[]
  suggestions: string[]
  rootCauses: UrlInsights['rootCauses']
} => {
  const failingChecks = apiChecks.filter((item) => item.status === 'fail')
  if (!failingChecks.length) return { issues: [], suggestions: [], rootCauses: [] }

  const issues = failingChecks.map((item) => {
    const p95Text = item.callTimeP95Ms === null ? 'N/A' : `${item.callTimeP95Ms} ms`
    const failText = item.callsFailedRate === null ? 'N/A' : `${item.callsFailedRate}%`
    return lang === 'es'
      ? `API degradada (${item.name}): p95 ${p95Text}, fallas ${failText}.`
      : `API degradation (${item.name}): p95 ${p95Text}, failures ${failText}.`
  })

  return {
    issues,
    suggestions: [t(lang, 'optimizeBackend')],
    rootCauses: [
      {
        cause:
          lang === 'es'
            ? 'Uno o más endpoints API superan el umbral esperado'
            : 'One or more API endpoints exceed expected thresholds',
        evidence:
          lang === 'es'
            ? `${failingChecks.length} endpoint(s) con p95 > ${API_CHECK_P95_THRESHOLD_MS} ms o error rate > ${API_CHECK_FAIL_RATE_THRESHOLD_PERCENT}%.`
            : `${failingChecks.length} endpoint(s) with p95 > ${API_CHECK_P95_THRESHOLD_MS} ms or error rate > ${API_CHECK_FAIL_RATE_THRESHOLD_PERCENT}%.`,
        impact: 'high',
        possibleFix:
          lang === 'es'
            ? 'Optimiza endpoints lentos, agrega caché y revisa dependencias externas.'
            : 'Optimize slow endpoints, add caching, and review external dependencies.',
      },
    ],
  }
}
