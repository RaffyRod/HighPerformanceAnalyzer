<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AnalyzeApiResponse } from './types/api'

const { t, locale } = useI18n()

const form = reactive({
  url: '',
  bearerToken: '',
  language: 'es' as 'es' | 'en',
  includeDiscoveredUrls: true,
})

const loading = ref(false)
const errorMessage = ref('')
const report = ref<AnalyzeApiResponse | null>(null)
const progress = ref(0)
const phaseIndex = ref(0)
const progressInterval = ref<number | null>(null)

const phases = ['phaseDiscovery', 'phaseLighthouse', 'phaseLoad', 'phaseReport'] as const
const currentPhase = computed<string>(
  () => phases[Math.min(phaseIndex.value, phases.length - 1)] ?? 'phaseDiscovery',
)

const stopProgress = (): void => {
  if (progressInterval.value !== null) {
    window.clearInterval(progressInterval.value)
    progressInterval.value = null
  }
}

const startProgress = (): void => {
  progress.value = 8
  phaseIndex.value = 0
  stopProgress()

  progressInterval.value = window.setInterval(() => {
    if (progress.value >= 92) return

    progress.value += 2
    if (progress.value > 28) phaseIndex.value = 1
    if (progress.value > 58) phaseIndex.value = 2
    if (progress.value > 82) phaseIndex.value = 3
  }, 500)
}

const setLanguage = (language: 'es' | 'en'): void => {
  form.language = language
  locale.value = language
}

const runAnalysis = async (): Promise<void> => {
  loading.value = true
  errorMessage.value = ''
  report.value = null
  locale.value = form.language
  startProgress()

  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: form.url,
        bearerToken: form.bearerToken || undefined,
        language: form.language,
        includeDiscoveredUrls: form.includeDiscoveredUrls,
      }),
    })

    if (!response.ok) {
      const failurePayload = (await response.json().catch(() => null)) as {
        message?: string
      } | null
      throw new Error(failurePayload?.message || t('error'))
    }

    report.value = (await response.json()) as AnalyzeApiResponse
    progress.value = 100
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : t('error')
  } finally {
    stopProgress()
    loading.value = false
  }
}
</script>

<template>
  <main class="container">
    <section class="hero">
      <h1>{{ t('title') }}</h1>
      <p class="subtitle">{{ t('subtitle') }}</p>
    </section>

    <section class="panel">
      <form class="form" @submit.prevent="runAnalysis">
        <div class="toolbar">
          <span class="toolbar-label">{{ t('language') }}</span>
          <div class="language-toggle" role="group" :aria-label="t('language')">
            <button
              type="button"
              class="toggle-btn"
              :class="{ active: form.language === 'es' }"
              :disabled="loading"
              @click="setLanguage('es')"
            >
              ES
            </button>
            <button
              type="button"
              class="toggle-btn"
              :class="{ active: form.language === 'en' }"
              :disabled="loading"
              @click="setLanguage('en')"
            >
              EN
            </button>
          </div>
        </div>

        <label>
          {{ t('targetUrl') }}
          <input v-model="form.url" type="url" required placeholder="https://example.com" />
        </label>

        <label>
          {{ t('bearerToken') }}
          <input v-model="form.bearerToken" type="password" placeholder="eyJ..." />
        </label>

        <label class="checkbox-row">
          <input v-model="form.includeDiscoveredUrls" type="checkbox" />
          <span>{{ t('includeDiscoveredUrls') }}</span>
        </label>

        <button type="submit" class="primary-btn" :disabled="loading">
          {{ loading ? t('running') : t('runAnalysis') }}
        </button>
      </form>
    </section>

    <section v-if="loading" class="panel progress-panel">
      <div class="progress-header">
        <strong>{{ t('running') }}</strong>
        <span>{{ progress }}%</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" :style="{ width: `${progress}%` }"></div>
      </div>
      <p class="phase">
        <span>{{ t('analyzingPhase') }}:</span>
        <b>{{ t(currentPhase) }}</b>
      </p>
    </section>

    <p v-if="errorMessage" class="error">{{ errorMessage }}</p>

    <section v-if="report" class="report">
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
