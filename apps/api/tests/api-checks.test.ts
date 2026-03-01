import { describe, expect, it } from 'vitest'
import {
  API_CHECK_FAIL_RATE_THRESHOLD_PERCENT,
  API_CHECK_P95_THRESHOLD_MS,
  buildApiCheckFindings,
  mapApiCheckMetrics,
  normalizeApiChecks,
} from '../src/utils/api-checks'

describe('api checks utils', () => {
  it('normalizes api checks and injects bearer auth header', () => {
    const checks = normalizeApiChecks(
      [
        {
          name: 'Users API',
          url: 'https://example.com/api/users',
          method: 'get',
        },
      ],
      'token-123',
    )

    expect(checks).toHaveLength(1)
    expect(checks[0]?.method).toBe('GET')
    expect(checks[0]?.headers.Authorization).toBe('Bearer token-123')
  })

  it('maps k6 metrics into api check results', () => {
    const checks = normalizeApiChecks(
      [
        {
          name: 'Health API',
          url: 'https://example.com/api/health',
          method: 'GET',
        },
      ],
      undefined,
    )

    const result = mapApiCheckMetrics(checks, {
      api_check_0_duration: {
        avg: 120,
        'p(95)': API_CHECK_P95_THRESHOLD_MS + 50,
      },
      api_check_0_failed: {
        rate: (API_CHECK_FAIL_RATE_THRESHOLD_PERCENT + 1) / 100,
      },
    })

    expect(result[0]?.status).toBe('fail')
    expect(result[0]?.callTimeP95Ms).toBe(API_CHECK_P95_THRESHOLD_MS + 50)
  })

  it('builds api findings when failing checks exist', () => {
    const findings = buildApiCheckFindings('en', [
      {
        name: 'Orders API',
        url: 'https://example.com/api/orders',
        method: 'GET',
        callTimeAvgMs: 400,
        callTimeP95Ms: 2200,
        callsFailedRate: 4,
        status: 'fail',
      },
    ])

    expect(findings.issues.length).toBe(1)
    expect(findings.rootCauses.length).toBe(1)
    expect(findings.suggestions.length).toBe(1)
  })
})
