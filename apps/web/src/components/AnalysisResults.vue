<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { AnalyzeApiResponse } from '../types/api'

defineProps<{
  report: AnalyzeApiResponse
}>()

const { t } = useI18n()
</script>

<template>
  <section class="report">
    <h2>{{ t('report') }}</h2>
    <p>
      <strong>{{ t('discoveredUrls') }}:</strong> {{ report.discoveredUrls.length }}
    </p>
    <a class="report-link" :href="report.htmlReportPath" target="_blank" rel="noreferrer">
      {{ t('openHtml') }}
    </a>

    <article v-for="result in report.results" :key="result.pageUrl" class="result">
      <h3>{{ result.pageUrl }}</h3>
      <p>
        <strong>{{ t('performance') }}:</strong> {{ result.performanceScore }}
      </p>
      <p>
        <strong>{{ t('pageLoad') }}:</strong> FCP {{ result.firstContentfulPaintMs ?? 'N/A' }} ms |
        LCP {{ result.largestContentfulPaintMs ?? 'N/A' }} ms | TTI
        {{ result.timeToInteractiveMs ?? 'N/A' }} ms
      </p>
      <p>
        <strong>{{ t('resources') }}:</strong> {{ result.totalByteWeightKb }} KB total |
        {{ result.imageBytesKb }} KB images | {{ result.videoBytesKb }} KB media
      </p>
      <p>
        <strong>{{ t('calls') }}:</strong> avg {{ result.callTimeAvgMs ?? 'N/A' }} ms | p95
        {{ result.callTimeP95Ms ?? 'N/A' }} ms | fail {{ result.callsFailedRate ?? 'N/A' }}%
      </p>

      <p>
        <strong>{{ t('issues') }}:</strong>
      </p>
      <ul>
        <li v-for="issue in result.issues" :key="issue">{{ issue }}</li>
      </ul>

      <p>
        <strong>{{ t('suggestions') }}:</strong>
      </p>
      <ul>
        <li v-for="suggestion in result.suggestions" :key="suggestion">{{ suggestion }}</li>
      </ul>
    </article>
  </section>
</template>
