<script setup lang="ts">
import { useI18n } from 'vue-i18n'

defineProps<{
  progress: number
  currentPhase: string
}>()

const { t } = useI18n()
</script>

<template>
  <section class="panel progress-panel">
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
</template>
