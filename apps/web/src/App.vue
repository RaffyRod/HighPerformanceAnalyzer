<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AnalyzeApiResponse } from './types/api'

const { t, locale } = useI18n()

const form = reactive({
  url: '',
  bearerToken: '',
  language: 'es',
})

const loading = ref(false)
const errorMessage = ref('')
const report = ref<AnalyzeApiResponse | null>(null)

const runAnalysis = async (): Promise<void> => {
  loading.value = true
  errorMessage.value = ''
  report.value = null
  locale.value = form.language

  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: form.url,
        bearerToken: form.bearerToken || undefined,
        language: form.language,
      }),
    })

    if (!response.ok) {
      throw new Error('Analysis request failed')
    }

    report.value = (await response.json()) as AnalyzeApiResponse
  } catch {
    errorMessage.value = t('error')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <main class="container">
    <h1>{{ t('title') }}</h1>
    <p class="subtitle">{{ t('subtitle') }}</p>

    <form class="form" @submit.prevent="runAnalysis">
      <label>
        {{ t('targetUrl') }}
        <input v-model="form.url" type="url" required placeholder="https://example.com" />
      </label>

      <label>
        {{ t('bearerToken') }}
        <input v-model="form.bearerToken" type="password" placeholder="eyJ..." />
      </label>

      <label>
        {{ t('language') }}
        <select v-model="form.language">
          <option value="es">Español</option>
          <option value="en">English</option>
        </select>
      </label>

      <button type="submit" :disabled="loading">
        {{ loading ? t('running') : t('runAnalysis') }}
      </button>
    </form>

    <p v-if="errorMessage" class="error">{{ errorMessage }}</p>

    <section v-if="report" class="report">
      <h2>{{ t('report') }}</h2>
      <p>
        <strong>{{ t('discoveredUrls') }}:</strong> {{ report.discoveredUrls.length }}
      </p>
      <a :href="report.htmlReportPath" target="_blank" rel="noreferrer">{{ t('openHtml') }}</a>

      <article v-for="result in report.results" :key="result.pageUrl" class="result">
        <h3>{{ result.pageUrl }}</h3>
        <p>
          <strong>{{ t('performance') }}:</strong> {{ result.performanceScore }}
        </p>
        <p>
          <strong>{{ t('pageLoad') }}:</strong> FCP {{ result.firstContentfulPaintMs ?? 'N/A' }} ms
          | LCP {{ result.largestContentfulPaintMs ?? 'N/A' }} ms | TTI
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
  </main>
</template>
