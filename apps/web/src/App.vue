<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AnalyzeApiResponse } from './types/api'
import AnalysisForm from './components/AnalysisForm.vue'
import AnalysisProgress from './components/AnalysisProgress.vue'
import AnalysisResults from './components/AnalysisResults.vue'

const { t, locale } = useI18n()
const SAVED_URLS_STORAGE_KEY = 'hpa-saved-urls'
const MAX_SAVED_URLS = 10

const form = reactive({
  url: '',
  urlsBatchText: '',
  bearerToken: '',
  language: 'en' as 'es' | 'en',
  analysisMode: 'single' as 'single' | 'multi',
  includeDiscoveredUrls: false,
})

const loading = ref(false)
const errorMessage = ref('')
const report = ref<AnalyzeApiResponse | null>(null)
const savedUrls = ref<string[]>([])
const apiReachable = ref<boolean | null>(null)
const apiHealthChecking = ref(false)
const apiHealthInterval = ref<number | null>(null)
const lastApiCheckAt = ref<Date | null>(null)
const apiLastCheckClock = ref(Date.now())
const apiLastCheckClockInterval = ref<number | null>(null)
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

const apiStatusText = computed<string>(() => {
  if (apiHealthChecking.value && apiReachable.value === null) return t('apiStatusChecking')
  if (apiReachable.value === true) return t('apiStatusOnline')
  return t('apiStatusOffline')
})

const apiStatusClass = computed<string>(() => {
  if (apiHealthChecking.value && apiReachable.value === null) return 'checking'
  return apiReachable.value ? 'online' : 'offline'
})

const apiLastCheckText = computed<string>(() => {
  if (!lastApiCheckAt.value) return t('apiStatusLastCheckNone')

  const elapsedSeconds = Math.max(
    0,
    Math.floor((apiLastCheckClock.value - lastApiCheckAt.value.getTime()) / 1000),
  )

  if (elapsedSeconds < 5) return t('apiStatusCheckedNow')
  if (elapsedSeconds < 60) return t('apiStatusCheckedSecondsAgo', { count: elapsedSeconds })

  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  if (elapsedMinutes < 60) return t('apiStatusCheckedMinutesAgo', { count: elapsedMinutes })

  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return t('apiStatusCheckedHoursAgo', { count: elapsedHours })

  return lastApiCheckAt.value.toLocaleString([], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
})

const checkApiHealth = async (): Promise<boolean> => {
  apiHealthChecking.value = true
  try {
    const response = await fetch('/api/health', {
      signal: AbortSignal.timeout(4000),
    })
    const ok = response.ok
    apiReachable.value = ok
    return ok
  } catch {
    apiReachable.value = false
    return false
  } finally {
    lastApiCheckAt.value = new Date()
    apiHealthChecking.value = false
  }
}

const retryApiHealth = async (): Promise<void> => {
  await checkApiHealth()
}

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

const setAnalysisMode = (mode: 'single' | 'multi'): void => {
  form.analysisMode = mode
}

const parseMultiUrls = (): string[] =>
  form.urlsBatchText
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)

const normalizeSavedUrl = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed) return ''

  try {
    return new URL(trimmed).toString()
  } catch {
    return ''
  }
}

const persistSavedUrls = (): void => {
  localStorage.setItem(SAVED_URLS_STORAGE_KEY, JSON.stringify(savedUrls.value))
}

const saveCurrentUrl = (): void => {
  const normalizedUrl = normalizeSavedUrl(form.url)
  if (!normalizedUrl) {
    errorMessage.value = t('savedUrlsInvalidUrl')
    return
  }

  errorMessage.value = ''
  const withoutDuplicate = savedUrls.value.filter((item) => item !== normalizedUrl)
  savedUrls.value = [normalizedUrl, ...withoutDuplicate].slice(0, MAX_SAVED_URLS)
  form.url = normalizedUrl
  persistSavedUrls()
}

const selectSavedUrl = (value: string): void => {
  const normalizedUrl = normalizeSavedUrl(value)
  if (!normalizedUrl) return
  form.url = normalizedUrl
}

const runAnalysis = async (): Promise<void> => {
  const isMultiAnalysis = form.analysisMode === 'multi'
  const multiUrls = isMultiAnalysis ? parseMultiUrls() : []

  if (isMultiAnalysis) {
    if (multiUrls.length < 20) {
      errorMessage.value = t('multiMinUrlsError')
      return
    }
    const hasInvalidUrl = multiUrls.some((item) => {
      try {
        void new URL(item)
        return false
      } catch {
        return true
      }
    })
    if (hasInvalidUrl) {
      errorMessage.value = t('multiInvalidUrlsError')
      return
    }
  }

  const apiOk = await checkApiHealth()
  if (!apiOk) {
    errorMessage.value = t('networkError')
    return
  }

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
        url: isMultiAnalysis ? undefined : form.url,
        urls: isMultiAnalysis ? multiUrls : undefined,
        bearerToken: form.bearerToken || undefined,
        language: form.language,
        includeDiscoveredUrls: isMultiAnalysis ? false : form.includeDiscoveredUrls,
      }),
    })

    if (!response.ok) {
      const contentType = response.headers.get('content-type') ?? ''
      let failureMessage = ''

      if (contentType.includes('application/json')) {
        const failurePayload = (await response.json().catch(() => null)) as {
          message?: string
        } | null
        failureMessage = failurePayload?.message?.trim() ?? ''
      } else {
        const failureText = (await response.text().catch(() => '')).trim()
        if (failureText) {
          failureMessage = failureText.slice(0, 240)
        }
      }

      const statusInfo = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
      throw new Error(failureMessage || `${t('error')} (${statusInfo})`)
    }

    report.value = (await response.json()) as AnalyzeApiResponse
    progress.value = 100
  } catch (error) {
    if (error instanceof TypeError && error.message.toLowerCase().includes('fetch')) {
      errorMessage.value = t('networkError')
    } else {
      errorMessage.value = error instanceof Error ? error.message : t('error')
    }
  } finally {
    stopProgress()
    loading.value = false
  }
}

onMounted(() => {
  const rawSavedUrls = localStorage.getItem(SAVED_URLS_STORAGE_KEY)
  if (rawSavedUrls) {
    try {
      const parsed = JSON.parse(rawSavedUrls) as unknown
      if (Array.isArray(parsed)) {
        savedUrls.value = parsed
          .map((entry) => (typeof entry === 'string' ? normalizeSavedUrl(entry) : ''))
          .filter((entry) => entry.length > 0)
          .slice(0, MAX_SAVED_URLS)
      }
    } catch {
      savedUrls.value = []
    }
  }

  void checkApiHealth()
  apiHealthInterval.value = window.setInterval(() => {
    void checkApiHealth()
  }, 15000)
  apiLastCheckClockInterval.value = window.setInterval(() => {
    apiLastCheckClock.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (apiHealthInterval.value !== null) {
    window.clearInterval(apiHealthInterval.value)
    apiHealthInterval.value = null
  }
  if (apiLastCheckClockInterval.value !== null) {
    window.clearInterval(apiLastCheckClockInterval.value)
    apiLastCheckClockInterval.value = null
  }
})
</script>

<template>
  <main class="container">
    <section class="hero">
      <h1>{{ t('title') }}</h1>
      <p class="subtitle">{{ t('subtitle') }}</p>
    </section>

    <section class="api-status" :class="apiStatusClass" role="status" aria-live="polite">
      <span class="api-status-dot" aria-hidden="true"></span>
      <span class="api-status-label">{{ t('apiStatusLabel') }}:</span>
      <strong>{{ apiStatusText }}</strong>
      <span class="api-status-last-check"
        >{{ t('apiStatusLastCheckLabel') }}: {{ apiLastCheckText }}</span
      >
      <button
        type="button"
        class="api-status-retry"
        :disabled="apiHealthChecking"
        @click="retryApiHealth"
      >
        {{ t('apiStatusRetry') }}
      </button>
    </section>

    <AnalysisForm
      :loading="loading"
      :url="form.url"
      :urls-batch-text="form.urlsBatchText"
      :bearer-token="form.bearerToken"
      :language="form.language"
      :analysis-mode="form.analysisMode"
      :include-discovered-urls="form.includeDiscoveredUrls"
      :saved-urls="savedUrls"
      @submit="runAnalysis"
      @update:url="form.url = $event"
      @update:urls-batch-text="form.urlsBatchText = $event"
      @update:bearer-token="form.bearerToken = $event"
      @update:include-discovered-urls="form.includeDiscoveredUrls = $event"
      @update:language="setLanguage"
      @update:analysis-mode="setAnalysisMode"
      @save-url="saveCurrentUrl"
      @select-saved-url="selectSavedUrl"
    />

    <AnalysisProgress v-if="loading" :progress="progress" :current-phase="currentPhase" />

    <p v-if="errorMessage" class="error">{{ errorMessage }}</p>

    <AnalysisResults v-if="report" :report="report" />
  </main>
</template>
