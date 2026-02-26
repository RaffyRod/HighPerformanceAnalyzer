import type { LanguageCode } from '@hpa/shared/src/index.js'

const messages = {
  en: {
    lowPerformance: 'Performance score is below the expected threshold (0.8).',
    slowFcp: 'First Contentful Paint is slower than recommended (1.8s).',
    slowLcp: 'Largest Contentful Paint is slower than recommended (2.5s).',
    heavyPage: 'Total transferred bytes exceed the target threshold (2MB).',
    slowCalls: 'Average API call time is above 800ms.',
    highFailureRate: 'Request failure rate is above 1%.',
    improveImages: 'Optimize and compress large images to reduce transfer size.',
    reduceJs: 'Reduce JavaScript execution cost and remove unused code.',
    cacheAssets: 'Use stronger caching headers for static assets.',
    optimizeBackend: 'Review backend bottlenecks and tune API response times.',
  },
  es: {
    lowPerformance: 'El score de performance está por debajo del umbral esperado (0.8).',
    slowFcp: 'First Contentful Paint es más lento de lo recomendado (1.8s).',
    slowLcp: 'Largest Contentful Paint es más lento de lo recomendado (2.5s).',
    heavyPage: 'Los bytes transferidos superan el umbral objetivo (2MB).',
    slowCalls: 'El tiempo promedio de llamadas API supera 800ms.',
    highFailureRate: 'La tasa de fallas en requests supera 1%.',
    improveImages: 'Optimiza y comprime imágenes grandes para reducir transferencia.',
    reduceJs: 'Reduce el costo de ejecución JavaScript y elimina código sin uso.',
    cacheAssets: 'Usa headers de caché más fuertes para assets estáticos.',
    optimizeBackend: 'Revisa cuellos de botella en backend y mejora tiempos de respuesta API.',
  },
} as const

export const t = (lang: LanguageCode, key: keyof (typeof messages)['en']): string =>
  messages[lang][key]
