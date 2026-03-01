import { describe, expect, it } from 'vitest'
import {
  MAX_MULTI_ANALYSIS_URLS,
  validateAndNormalizeAnalyzeRequest,
} from '../src/utils/analyze-request'

describe('validateAndNormalizeAnalyzeRequest', () => {
  it('returns 400 when single analysis URL is missing', () => {
    const result = validateAndNormalizeAnalyzeRequest({
      language: 'es',
      includeDiscoveredUrls: true,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.statusCode).toBe(400)
    expect(result.message).toContain('url is required')
  })

  it('normalizes and accepts a valid single analysis request', () => {
    const result = validateAndNormalizeAnalyzeRequest({
      url: ' https://example.com ',
      bearerToken: ' token-123 ',
      language: 'es',
      includeDiscoveredUrls: true,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.payload.url).toBe('https://example.com')
    expect(result.payload.bearerToken).toBe('token-123')
    expect(result.payload.language).toBe('es')
    expect(result.payload.includeDiscoveredUrls).toBe(true)
    expect(result.payload.urls).toBeUndefined()
  })

  it('defaults includeDiscoveredUrls to true for single analysis', () => {
    const result = validateAndNormalizeAnalyzeRequest({
      url: 'https://example.com',
      language: 'en',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.payload.includeDiscoveredUrls).toBe(true)
  })

  it('accepts multi-analysis with fewer than 20 URLs', () => {
    const urls = Array.from({ length: 5 }, (_, index) => {
      return `https://example.com/page-${index + 1}`
    })

    const result = validateAndNormalizeAnalyzeRequest({
      urls,
      language: 'en',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.payload.urls).toHaveLength(5)
  })

  it('returns 400 when multi-analysis exceeds maximum URLs', () => {
    const urls = Array.from({ length: MAX_MULTI_ANALYSIS_URLS + 1 }, (_, index) => {
      return `https://example.com/page-${index + 1}`
    })

    const result = validateAndNormalizeAnalyzeRequest({
      urls,
      language: 'en',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.statusCode).toBe(400)
    expect(result.message).toContain(`${MAX_MULTI_ANALYSIS_URLS}`)
  })

  it('normalizes valid multi-analysis and forces includeDiscoveredUrls false', () => {
    const urls = Array.from({ length: MAX_MULTI_ANALYSIS_URLS }, (_, index) => {
      return `https://example.com/page-${index + 1}`
    })

    const result = validateAndNormalizeAnalyzeRequest({
      urls: [
        'https://example.com/page-1',
        ' https://example.com/page-2 ',
        ...urls.slice(2),
        'https://example.com/page-2',
      ],
      language: 'es',
      includeDiscoveredUrls: true,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.payload.urls?.length).toBe(MAX_MULTI_ANALYSIS_URLS)
    expect(result.payload.urls?.[1]).toBe('https://example.com/page-2')
    expect(result.payload.includeDiscoveredUrls).toBe(false)
  })

  it('normalizes api checks from request payload', () => {
    const result = validateAndNormalizeAnalyzeRequest({
      url: 'https://example.com',
      language: 'en',
      apiChecks: [
        {
          name: 'Users',
          url: 'https://example.com/api/users',
          method: 'get',
        },
      ],
      bearerToken: 'token-123',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.payload.apiChecks?.[0]?.method).toBe('GET')
    expect(result.payload.apiChecks?.[0]?.headers?.Authorization).toBe('Bearer token-123')
  })

  it('returns 400 for invalid api check method', () => {
    const result = validateAndNormalizeAnalyzeRequest({
      url: 'https://example.com',
      language: 'en',
      apiChecks: [
        {
          url: 'https://example.com/api/users',
          method: 'OPTIONS' as never,
        },
      ],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.statusCode).toBe(400)
  })
})
