import { expect, test, type Page } from '@playwright/test'

/**
 * Returns key form controls used across tests.
 */
const getFormControls = (page: Page) => ({
  languageEs: page.getByRole('button', { name: 'ES', exact: true }),
  languageEn: page.getByRole('button', { name: 'EN', exact: true }),
  urlInput: page.getByRole('textbox', { name: /URL objetivo|Target URL/ }),
  tokenInput: page.getByRole('textbox', { name: /Bearer token/ }),
  includeDiscoveredUrlsCheckbox: page.getByRole('checkbox', {
    name: /Analizar URLs internas descubiertas|Analyze discovered internal URLs/,
  }),
  runAnalysisButton: page.getByRole('button', { name: /Ejecutar análisis|Run analysis/ }),
})

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test.afterEach(async ({ page }) => {
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+/)
})

test('shows analysis form with required controls', async ({ page }) => {
  const controls = getFormControls(page)
  await expect(page.getByRole('heading', { name: 'High Performance Analyzer' })).toBeVisible()
  await expect(controls.languageEs).toBeVisible()
  await expect(controls.languageEn).toBeVisible()
  await expect(controls.urlInput).toBeVisible()
  await expect(controls.tokenInput).toBeVisible()
  await expect(controls.includeDiscoveredUrlsCheckbox).toBeVisible()
  await expect(controls.runAnalysisButton).toBeVisible()
})

test('keeps discovered URLs checkbox unchecked by default', async ({ page }) => {
  const controls = getFormControls(page)
  await expect(controls.includeDiscoveredUrlsCheckbox).not.toBeChecked()
})
