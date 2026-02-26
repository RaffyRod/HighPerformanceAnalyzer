import { createI18n } from 'vue-i18n'

export const messages = {
  en: {
    title: 'High Performance Analyzer',
    subtitle:
      'Analyze a website with URL discovery, Lighthouse audits, and k6 performance testing.',
    targetUrl: 'Target URL',
    bearerToken: 'Bearer token (optional)',
    language: 'Language',
    runAnalysis: 'Run analysis',
    running: 'Running analysis...',
    report: 'Report',
    discoveredUrls: 'Discovered URLs',
    openHtml: 'Open HTML report',
    performance: 'Performance',
    pageLoad: 'Page load',
    resources: 'Resources',
    calls: 'Calls',
    issues: 'Issues',
    suggestions: 'Suggestions',
    error: 'Analysis failed. Verify URL, auth token, Chrome, and k6 installation.',
  },
  es: {
    title: 'Analizador de Alto Rendimiento',
    subtitle:
      'Analiza un sitio con descubrimiento de URLs, auditorías Lighthouse y pruebas de rendimiento con k6.',
    targetUrl: 'URL objetivo',
    bearerToken: 'Bearer token (opcional)',
    language: 'Idioma',
    runAnalysis: 'Ejecutar análisis',
    running: 'Ejecutando análisis...',
    report: 'Reporte',
    discoveredUrls: 'URLs descubiertas',
    openHtml: 'Abrir reporte HTML',
    performance: 'Rendimiento',
    pageLoad: 'Carga de página',
    resources: 'Recursos',
    calls: 'Llamadas',
    issues: 'Problemas',
    suggestions: 'Sugerencias',
    error: 'El análisis falló. Verifica URL, token, Chrome y la instalación de k6.',
  },
}

export const i18n = createI18n({
  legacy: false,
  locale: 'es',
  fallbackLocale: 'en',
  messages,
})
