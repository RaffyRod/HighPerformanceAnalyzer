import { describe, expect, it } from 'vitest'
import { t } from '../src/utils/i18n'

describe('backend i18n translations', () => {
  it('returns English translation for known key', () => {
    expect(t('en', 'reduceJs')).toBe('Reduce JavaScript execution cost and remove unused code.')
  })

  it('returns Spanish translation for known key', () => {
    expect(t('es', 'optimizeBackend')).toBe(
      'Revisa cuellos de botella en backend y mejora tiempos de respuesta API.',
    )
  })
})
