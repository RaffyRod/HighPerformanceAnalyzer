<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  loading: boolean
  url: string
  bearerToken: string
  language: 'es' | 'en'
  includeDiscoveredUrls: boolean
}>()

const emit = defineEmits<{
  (event: 'submit'): void
  (event: 'update:url', value: string): void
  (event: 'update:bearer-token', value: string): void
  (event: 'update:language', value: 'es' | 'en'): void
  (event: 'update:include-discovered-urls', value: boolean): void
}>()

const { t } = useI18n()

const onUrlInput = (event: Event): void => {
  emit('update:url', (event.target as HTMLInputElement).value)
}

const onBearerTokenInput = (event: Event): void => {
  emit('update:bearer-token', (event.target as HTMLInputElement).value)
}

const onIncludeDiscoveredUrlsChange = (event: Event): void => {
  emit('update:include-discovered-urls', (event.target as HTMLInputElement).checked)
}

const setLanguage = (language: 'es' | 'en'): void => {
  emit('update:language', language)
}
</script>

<template>
  <section class="panel">
    <form class="form" @submit.prevent="emit('submit')">
      <div class="toolbar">
        <span class="toolbar-label">{{ t('language') }}</span>
        <div class="language-toggle" role="group" :aria-label="t('language')">
          <button
            type="button"
            class="toggle-btn"
            :class="{ active: props.language === 'es' }"
            :disabled="props.loading"
            @click="setLanguage('es')"
          >
            ES
          </button>
          <button
            type="button"
            class="toggle-btn"
            :class="{ active: props.language === 'en' }"
            :disabled="props.loading"
            @click="setLanguage('en')"
          >
            EN
          </button>
        </div>
      </div>

      <label>
        {{ t('targetUrl') }}
        <input
          :value="props.url"
          type="url"
          required
          placeholder="https://example.com"
          @input="onUrlInput"
        />
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
