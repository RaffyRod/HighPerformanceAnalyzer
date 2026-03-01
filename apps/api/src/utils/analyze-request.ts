import type { AnalyzeRequest, LanguageCode } from '@hpa/shared'
import { normalizeApiChecks } from './api-checks.js'

export const MAX_MULTI_ANALYSIS_URLS = 20

type ValidationError = {
  ok: false
  statusCode: number
  message: string
}

type ValidationSuccess = {
  ok: true
  payload: AnalyzeRequest
}

export type ValidateAnalyzeRequestResult = ValidationError | ValidationSuccess

export const validateAndNormalizeAnalyzeRequest = (
  body: AnalyzeRequest | undefined,
): ValidateAnalyzeRequestResult => {
  const normalizedUrls = Array.isArray(body?.urls)
    ? body.urls.map((value) => value.trim()).filter((value) => value.length > 0)
    : []
  const uniqueUrls = [...new Set(normalizedUrls)]
  const isMultiAnalysis = uniqueUrls.length > 0

  if (!isMultiAnalysis && !body?.url?.trim()) {
    return {
      ok: false,
      statusCode: 400,
      message: 'url is required for single analysis',
    }
  }

  if (isMultiAnalysis && uniqueUrls.length > MAX_MULTI_ANALYSIS_URLS) {
    return {
      ok: false,
      statusCode: 400,
      message: `multi-analysis supports up to ${MAX_MULTI_ANALYSIS_URLS} URLs`,
    }
  }

  const language: LanguageCode = body?.language === 'es' ? 'es' : 'en'
  let apiChecks = undefined
  try {
    const normalizedChecks = normalizeApiChecks(body?.apiChecks, body?.bearerToken?.trim())
    apiChecks = normalizedChecks.length ? normalizedChecks : undefined
  } catch (error) {
    return {
      ok: false,
      statusCode: 400,
      message: error instanceof Error ? error.message : 'Invalid API checks payload',
    }
  }

  return {
    ok: true,
    payload: {
      url: body?.url?.trim() || undefined,
      urls: isMultiAnalysis ? uniqueUrls : undefined,
      apiChecks,
      bearerToken: body?.bearerToken?.trim() || undefined,
      language,
      includeDiscoveredUrls: isMultiAnalysis ? false : body?.includeDiscoveredUrls !== false,
    },
  }
}
