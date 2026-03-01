import type { ApiCheckRequest, ApiCheckResult, LanguageCode, UrlInsights } from '@hpa/shared'
import { t } from './i18n.js'

export const API_CHECK_P95_THRESHOLD_MS = 1200
export const API_CHECK_FAIL_RATE_THRESHOLD_PERCENT = 1

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

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
