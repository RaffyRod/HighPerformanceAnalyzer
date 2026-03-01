<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  loading: boolean
  url: string
  urlsBatchText: string
  bearerToken: string
  language: 'es' | 'en'
  analysisMode: 'single' | 'multi'
  includeDiscoveredUrls: boolean
  savedUrls: string[]
}>()

const emit = defineEmits<{
  (event: 'submit'): void
  (event: 'update:url', value: string): void
  (event: 'update:urls-batch-text', value: string): void
  (event: 'update:bearer-token', value: string): void
  (event: 'update:language', value: 'es' | 'en'): void
  (event: 'update:analysis-mode', value: 'single' | 'multi'): void
  (event: 'update:include-discovered-urls', value: boolean): void
  (event: 'save-url'): void
  (event: 'select-saved-url', value: string): void
}>()

const { t } = useI18n()
const savedUrlsMenu = ref<HTMLDetailsElement | null>(null)

const onUrlInput = (event: Event): void => {
  emit('update:url', (event.target as HTMLInputElement).value)
}

const onBearerTokenInput = (event: Event): void => {
  emit('update:bearer-token', (event.target as HTMLInputElement).value)
}

const onUrlsBatchInput = (event: Event): void => {
  emit('update:urls-batch-text', (event.target as HTMLTextAreaElement).value)
}

const onSavedUrlPick = (value: string): void => {
  emit('select-saved-url', value)
  if (savedUrlsMenu.value) {
    savedUrlsMenu.value.open = false
  }
}

const onIncludeDiscoveredUrlsChange = (event: Event): void => {
  emit('update:include-discovered-urls', (event.target as HTMLInputElement).checked)
}

const setLanguage = (language: 'es' | 'en'): void => {
  emit('update:language', language)
}

const setAnalysisMode = (mode: 'single' | 'multi'): void => {
  emit('update:analysis-mode', mode)
}

const formatSavedUrlLabel = (value: string): string => {
  const maxLength = 72
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`
}
</script>

<template>
  <section class="panel">
    <form class="form" @submit.prevent="emit('submit')">
      <div class="toolbar toolbar-dual">
        <div class="toolbar-left">
          <span class="toolbar-label">{{ t('analysisMode') }}</span>
          <div class="mode-radio-group" role="radiogroup" :aria-label="t('analysisMode')">
            <label class="mode-radio-option">
              <input
                class="mode-radio-input"
                type="radio"
                name="analysis-mode"
                :checked="props.analysisMode === 'single'"
                :disabled="props.loading"
                @change="setAnalysisMode('single')"
              />
              <span>{{ t('singleAnalysis') }}</span>
            </label>
            <label class="mode-radio-option">
              <input
                class="mode-radio-input"
                type="radio"
                name="analysis-mode"
                :checked="props.analysisMode === 'multi'"
                :disabled="props.loading"
                @change="setAnalysisMode('multi')"
              />
              <span>{{ t('multiAnalysis') }}</span>
            </label>
          </div>
        </div>
        <div class="toolbar-right">
          <div
            class="language-toggle language-toggle-compact"
            role="group"
            :aria-label="t('language')"
          >
            <button
              type="button"
              class="toggle-btn toggle-btn-compact"
              :class="{ active: props.language === 'es' }"
              :disabled="props.loading"
              @click="setLanguage('es')"
            >
              ES
            </button>
            <button
              type="button"
              class="toggle-btn toggle-btn-compact"
              :class="{ active: props.language === 'en' }"
              :disabled="props.loading"
              @click="setLanguage('en')"
            >
              EN
            </button>
          </div>
        </div>
      </div>

      <label v-if="props.analysisMode === 'single'">
        {{ t('targetUrl') }}
        <div class="url-row">
          <input
            :value="props.url"
            type="url"
            required
            placeholder="https://example.com"
            @input="onUrlInput"
          />
          <button
            type="button"
            class="secondary-btn"
            :disabled="props.loading || !props.url.trim()"
            @click="emit('save-url')"
          >
            {{ t('saveUrl') }}
          </button>
          <details ref="savedUrlsMenu" class="saved-url-menu" :class="{ disabled: props.loading }">
            <summary
              class="saved-url-menu-trigger"
              :aria-label="t('savedUrls')"
              :title="t('savedUrls')"
            >
              {{ t('savedUrlsMenu') }}
              <span aria-hidden="true">▾</span>
            </summary>
            <div class="saved-url-menu-panel">
              <p v-if="!props.savedUrls.length" class="saved-url-menu-empty">
                {{ t('noSavedUrls') }}
              </p>
              <button
                v-for="savedUrl in props.savedUrls"
                v-else
                :key="savedUrl"
                type="button"
                class="saved-url-option"
                :title="savedUrl"
                @click="onSavedUrlPick(savedUrl)"
              >
                {{ formatSavedUrlLabel(savedUrl) }}
              </button>
            </div>
          </details>
        </div>
      </label>

      <label v-else>
        {{ t('multiUrlsLabel') }}
        <textarea
          class="multi-url-textarea"
          :value="props.urlsBatchText"
          :placeholder="t('multiUrlsPlaceholder')"
          :disabled="props.loading"
          @input="onUrlsBatchInput"
        ></textarea>
        <span class="field-hint">{{ t('multiUrlsHint') }}</span>
      </label>

      <label>
        {{ t('bearerToken') }}
        <input
          :value="props.bearerToken"
          type="password"
          placeholder="eyJ..."
          @input="onBearerTokenInput"
        />
      </label>

      <label class="checkbox-row">
        <input
          :checked="props.includeDiscoveredUrls"
          type="checkbox"
          :disabled="props.loading || props.analysisMode === 'multi'"
          @change="onIncludeDiscoveredUrlsChange"
        />
        <span>{{ t('includeDiscoveredUrls') }}</span>
      </label>

      <button type="submit" class="primary-btn" :disabled="props.loading">
        {{ props.loading ? t('running') : t('runAnalysis') }}
      </button>
    </form>
  </section>
</template>
