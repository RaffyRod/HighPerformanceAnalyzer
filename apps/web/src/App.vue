<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AnalyzeApiResponse } from './types/api'
import AnalysisForm from './components/AnalysisForm.vue'
import AnalysisProgress from './components/AnalysisProgress.vue'
import AnalysisResults from './components/AnalysisResults.vue'

const { t, locale } = useI18n()

const form = reactive({
  url: '',
  bearerToken: '',
  language: 'es' as 'es' | 'en',
  includeDiscoveredUrls: false,
})

const loading = ref(false)
const errorMessage = ref('')
const report = ref<AnalyzeApiResponse | null>(null)
const progress = ref(0)
const phaseIndex = ref(0)
const progressInterval = ref<number | null>(null)
const progressPhases = ref<readonly string[]>([
  'phaseDiscovery',
  'phaseLighthouse',
  'phaseLoad',
  'phaseReport',
])

const currentPhase = computed<string>(
  () =>
    progressPhases.value[Math.min(phaseIndex.value, progressPhases.value.length - 1)] ??
    'phasePrepare',
)

const stopProgress = (): void => {
  if (progressInterval.value !== null) {
    window.clearInterval(progressInterval.value)
    progressInterval.value = null
  }
}

const startProgress = (includeDiscoveredUrls: boolean): void => {
  progressPhases.value = includeDiscoveredUrls
    ? ['phaseDiscovery', 'phaseLighthouse', 'phaseLoad', 'phaseReport']
    : ['phasePrepare', 'phaseLighthouse', 'phaseLoad', 'phaseReport']

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
  startProgress(form.includeDiscoveredUrls)

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

    <AnalysisForm
      :loading="loading"
      :url="form.url"
      :bearer-token="form.bearerToken"
      :language="form.language"
      :include-discovered-urls="form.includeDiscoveredUrls"
      @submit="runAnalysis"
      @update:url="form.url = $event"
      @update:bearer-token="form.bearerToken = $event"
      @update:include-discovered-urls="form.includeDiscoveredUrls = $event"
      @update:language="setLanguage"
    />

    <AnalysisProgress v-if="loading" :progress="progress" :current-phase="currentPhase" />

    <p v-if="errorMessage" class="error">{{ errorMessage }}</p>

    <AnalysisResults v-if="report" :report="report" />
  </main>
</template>
