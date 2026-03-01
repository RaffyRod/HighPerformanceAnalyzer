import { describe, expect, it } from 'vitest'
import {
  API_CHECK_FAIL_RATE_THRESHOLD_PERCENT,
  API_CHECK_P95_THRESHOLD_MS,
  buildApiCheckFindings,
  discoverApiChecksFromHtml,
  mapApiCheckMetrics,
  mergeApiChecks,
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

  it('discovers same-origin api checks from html', () => {
    const html = `
      <html>
        <body>
          <form action="/api/orders" method="post"></form>
          <script>
            fetch('/api/users')
            fetch('/graphql', { method: 'POST' })
            axios.get('/api/health')
            axios({
              url: '/rest/products',
              method: 'PATCH'
            })
          </script>
        </body>
      </html>
    `
    const checks = discoverApiChecksFromHtml('https://example.com/home', html, 'token-123')

    expect(checks.length).toBeGreaterThanOrEqual(4)
    expect(checks.some((item) => item.url === 'https://example.com/api/users')).toBe(true)
    expect(checks.some((item) => item.url === 'https://example.com/graphql')).toBe(true)
    expect(checks.some((item) => item.method === 'POST' && item.url.endsWith('/api/orders'))).toBe(
      true,
    )
    expect(checks[0]?.headers.Authorization).toBe('Bearer token-123')
  })

  it('merges discovered and user api checks without duplicates', () => {
    const discovered = normalizeApiChecks(
      [
        {
          name: 'Auto Users',
          url: 'https://example.com/api/users',
          method: 'GET',
        },
      ],
      undefined,
    )
    const user = normalizeApiChecks(
      [
        {
          name: 'Users custom',
          url: 'https://example.com/api/users',
          method: 'GET',
        },
        {
          name: 'Orders custom',
          url: 'https://example.com/api/orders',
          method: 'POST',
        },
      ],
      undefined,
    )

    const merged = mergeApiChecks(discovered, user)
    expect(merged).toHaveLength(2)
    expect(merged.some((item) => item.url.endsWith('/api/users'))).toBe(true)
    expect(merged.some((item) => item.url.endsWith('/api/orders') && item.method === 'POST')).toBe(
      true,
    )
  })
})
