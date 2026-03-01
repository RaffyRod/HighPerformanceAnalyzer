<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { AnalyzeApiResponse } from '../types/api'

const props = defineProps<{
  report: AnalyzeApiResponse
}>()

const { t } = useI18n()

const formatMs = (value: number | null): string => {
  if (typeof value !== 'number') return 'N/A'
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`
}

const formatKb = (value: number | null): string => {
  if (typeof value !== 'number') return 'N/A'
  return value >= 1024 ? `${(value / 1024).toFixed(2)} MB` : `${value.toFixed(2)} KB`
}

const formatPercent = (value: number | null): string =>
  typeof value === 'number' ? `${value.toFixed(2)}%` : 'N/A%'

const scoreClass = (score: number): 'good' | 'average' | 'poor' =>
  score >= 0.8 ? 'good' : score >= 0.5 ? 'average' : 'poor'

const parseFirstNumber = (value: string): number | null => {
  const match = value.match(/(\d+(?:\.\d+)?)/)
  return match ? Number(match[1]) : null
}

const getOpportunityExpected = (title: string): string => {
  const normalized = title.toLowerCase()
  if (normalized.includes('first contentful paint')) return '<= 1.8 s'
  if (normalized.includes('largest contentful paint')) return '<= 2.5 s'
  if (normalized.includes('speed index')) return '<= 3.4 s'
  if (normalized.includes('total blocking time')) return '<= 200 ms'
  if (normalized.includes('max potential first input delay')) return '<= 100 ms'
  if (normalized.includes('cumulative layout shift')) return '<= 0.10'
  return 'Score >= 0.90'
}

const getOpportunityStatus = (
  title: string,
  detail: string,
  score: number | null,
): 'good' | 'poor' | 'average' => {
  const normalized = title.toLowerCase()
  const current = parseFirstNumber(detail)
  if (typeof current === 'number') {
    if (normalized.includes('first contentful paint')) return current <= 1.8 ? 'good' : 'poor'
    if (normalized.includes('largest contentful paint')) return current <= 2.5 ? 'good' : 'poor'
    if (normalized.includes('speed index')) return current <= 3.4 ? 'good' : 'poor'
    if (normalized.includes('total blocking time')) return current <= 200 ? 'good' : 'poor'
    if (normalized.includes('max potential first input delay'))
      return current <= 100 ? 'good' : 'poor'
    if (normalized.includes('cumulative layout shift')) return current <= 0.1 ? 'good' : 'poor'
  }
  if (typeof score === 'number') return score >= 0.9 ? 'good' : score >= 0.5 ? 'average' : 'poor'
  return 'average'
}

const isOpportunityFailed = (title: string, detail: string, score: number | null): boolean =>
  getOpportunityStatus(title, detail, score) !== 'good'

const getSortedOpportunities = (
  opportunities: AnalyzeApiResponse['results'][number]['opportunities'],
) =>
  [...opportunities].sort((left, right) => {
    const leftFailed = isOpportunityFailed(left.title, left.detail, left.score)
    const rightFailed = isOpportunityFailed(right.title, right.detail, right.score)
    if (leftFailed !== rightFailed) return leftFailed ? -1 : 1
    return left.title.localeCompare(right.title)
  })

const scoreSummary = (() => {
  if (!props.report.results.length) return 0
  const average =
    props.report.results.reduce((acc, item) => acc + item.performanceScore, 0) /
    props.report.results.length
  return Number((average * 100).toFixed(0))
})()

const hasAnyApiChecks = props.report.results.some((result) => result.apiChecks.length > 0)
</script>

<template>
  <section class="report">
    <div class="report-head panel">
      <div class="report-title-row">
        <h2>{{ t('report') }}</h2>
        <span
          v-if="report.results.length > 1"
          class="score-pill"
          :class="scoreClass(scoreSummary / 100)"
        >
          {{ t('performance') }} {{ scoreSummary }}%
        </span>
      </div>
      <div class="report-meta">
        <p>
          <strong>{{ t('discoveredUrls') }}:</strong> {{ report.discoveredUrls.length }}
        </p>
        <a
          class="report-link report-link-cta"
          :href="report.htmlReportPath"
          target="_blank"
          rel="noreferrer"
        >
          <span>{{ t('openHtml') }}</span>
          <span aria-hidden="true">↗</span>
        </a>
      </div>
    </div>

    <article v-for="result in report.results" :key="result.pageUrl" class="result">
      <div class="result-head">
        <h3>{{ result.pageUrl }}</h3>
        <span
          v-if="report.results.length > 1"
          class="score-pill"
          :class="scoreClass(result.performanceScore)"
        >
          {{ t('performance') }} {{ Math.round(result.performanceScore * 100) }}%
        </span>
      </div>

      <div class="metric-grid">
        <div class="metric-item">
          <span>FCP</span>
          <strong>{{ formatMs(result.firstContentfulPaintMs) }}</strong>
        </div>
        <div class="metric-item">
          <span>LCP</span>
          <strong>{{ formatMs(result.largestContentfulPaintMs) }}</strong>
        </div>
        <div class="metric-item">
          <span>TTI</span>
          <strong>{{ formatMs(result.timeToInteractiveMs) }}</strong>
        </div>
        <div class="metric-item">
          <span>{{ t('resources') }}</span>
          <strong>{{ formatKb(result.totalByteWeightKb) }}</strong>
        </div>
        <div class="metric-item">
          <span>{{ t('calls') }} p95</span>
          <strong>{{ formatMs(result.callTimeP95Ms) }}</strong>
        </div>
        <div class="metric-item">
          <span>{{ t('calls') }} fail</span>
          <strong>{{ formatPercent(result.callsFailedRate) }}</strong>
        </div>
      </div>

      <p v-if="hasAnyApiChecks">
        <strong>{{ t('apiChecksTitle') }}:</strong>
      </p>
      <ul v-if="result.apiChecks.length > 0" class="result-list opportunity-list">
        <li v-for="apiCheck in result.apiChecks" :key="apiCheck.method + apiCheck.url">
          <div class="opportunity-head">
            <strong>{{ apiCheck.name }}</strong>
          </div>
          <div class="opportunity-detail">
            <span v-if="apiCheck.status === 'fail'">❌</span>
            <span v-else class="pass-emoji">✅</span>
            {{ apiCheck.method }} | {{ t('apiChecksP95') }}:
            <span
              class="current-value"
              :class="{ failed: apiCheck.status === 'fail', passed: apiCheck.status === 'pass' }"
            >
              {{ formatMs(apiCheck.callTimeP95Ms) }}
            </span>
            | {{ t('apiChecksFailRate') }}:
            <span
              class="current-value"
              :class="{ failed: apiCheck.status === 'fail', passed: apiCheck.status === 'pass' }"
            >
              {{ formatPercent(apiCheck.callsFailedRate) }}
            </span>
          </div>
        </li>
      </ul>

      <p>
        <strong>{{ t('issues') }}:</strong>
      </p>
      <ul class="result-list issue-list">
        <li v-for="issue in result.issues" :key="issue">{{ issue }}</li>
        <li v-if="!result.issues.length">{{ t('none') }}</li>
      </ul>

      <p>
        <strong>{{ t('suggestions') }}:</strong>
      </p>
      <ul class="result-list">
        <li v-for="suggestion in result.suggestions" :key="suggestion">{{ suggestion }}</li>
        <li v-if="!result.suggestions.length">{{ t('none') }}</li>
      </ul>

      <p>
        <strong>{{ t('opportunities') }}:</strong>
      </p>
      <ul class="result-list opportunity-list">
        <li
          v-for="opportunity in getSortedOpportunities(result.opportunities)"
          :key="opportunity.title + opportunity.detail"
        >
          <div class="opportunity-head">
            <strong>{{ opportunity.title }}</strong>
          </div>
          <div class="opportunity-detail">
            <span
              v-if="isOpportunityFailed(opportunity.title, opportunity.detail, opportunity.score)"
            >
              ❌
            </span>
            <span v-else class="pass-emoji">✅</span>
            {{ t('current') }}:
            <span
              class="current-value"
              :class="{
                failed: isOpportunityFailed(
                  opportunity.title,
                  opportunity.detail,
                  opportunity.score,
                ),
                passed: !isOpportunityFailed(
                  opportunity.title,
                  opportunity.detail,
                  opportunity.score,
                ),
              }"
            >
              {{ opportunity.detail }}
            </span>
            | {{ t('expected') }}:
            {{ getOpportunityExpected(opportunity.title) }}
          </div>
        </li>
        <li v-if="!result.opportunities.length">{{ t('none') }}</li>
      </ul>
    </article>
  </section>
</template>

<style scoped>
.report-head {
  margin-bottom: 10px;
  padding: 12px 14px;
}

.report-title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.report-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.report-meta p {
  margin: 0;
}

.report-link-cta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid #0f172a;
  background: #0f172a;
  color: #ffffff;
  font-weight: 800;
  letter-spacing: 0.2px;
  text-decoration: none;
  box-shadow: 0 8px 18px rgb(15 23 42 / 22%);
  transition:
    transform 120ms ease,
    box-shadow 180ms ease,
    opacity 120ms ease;
}

.report-link-cta:hover {
  text-decoration: none;
  transform: translateY(-1px);
  box-shadow: 0 10px 22px rgb(15 23 42 / 28%);
}

.result-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: flex-start;
  margin-bottom: 8px;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  margin-bottom: 8px;
}

.metric-item {
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 6px 8px;
  background: #f8fafc;
}

.metric-item span {
  display: block;
  color: #64748b;
  font-size: 0.76rem;
}

.metric-item strong {
  color: #0f172a;
  font-size: 0.86rem;
}

.score-pill {
  border-radius: 999px;
  font-weight: 700;
  font-size: 0.78rem;
  padding: 3px 9px;
  border: 1px solid transparent;
}

.score-pill.good {
  background: #ecfdf3;
  color: #166534;
  border-color: #bbf7d0;
}

.score-pill.average {
  background: #fffbeb;
  color: #92400e;
  border-color: #fde68a;
}

.score-pill.poor {
  background: #fef2f2;
  color: #991b1b;
  border-color: #fecaca;
}

.result-list {
  margin-top: 4px;
  display: grid;
  gap: 6px;
}

.result-list li {
  margin: 0;
}

.issue-list li {
  color: #991b1b;
  font-weight: 600;
}

.opportunity-list {
  list-style: none;
  padding-left: 0;
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.opportunity-list li {
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 7px 9px;
  background: #fff;
  margin: 0;
}

.opportunity-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: center;
}

.opportunity-detail {
  margin-top: 3px;
  color: #475569;
  font-size: 0.82rem;
}

.result p {
  margin: 6px 0 2px;
}

.current-value.failed {
  color: #dc2626;
  font-weight: 800;
  text-shadow: 0 0 6px rgb(220 38 38 / 30%);
}

.current-value.passed {
  color: #16a34a;
  font-weight: 800;
  text-shadow: 0 0 8px rgb(22 163 74 / 35%);
}

.pass-emoji {
  filter: drop-shadow(0 0 4px rgb(22 163 74 / 45%));
}

@media (max-width: 768px) {
  .report-head {
    padding: 10px 12px;
  }

  .metric-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .opportunity-list {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 480px) {
  .report-head {
    padding: 10px;
  }

  .metric-grid {
    grid-template-columns: 1fr;
  }

  .report-link-cta {
    width: 100%;
    justify-content: center;
  }
}
</style>
