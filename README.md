# High Performance Analyzer 🚀

High Performance Analyzer is a TypeScript monorepo that audits website performance with Lighthouse + k6 and delivers a bilingual, actionable HTML report for fast remediation.

## ✨ Why This Project

- 🌐 Analyze one URL or discovered internal URLs (same origin)
- ⚡ Measure key performance vitals (FCP, LCP, TTI, payload)
- 📡 Evaluate request latency and failure behavior with k6 (or safe fallback)
- 🌍 Use bilingual UX/reporting (`en` / `es`)
- 🇬🇧 Default language is English for both app and generated reports (switch anytime to ES)
- 📊 Get user-friendly HTML output with:
  - health badges and score cards
  - fail-first opportunities
  - `Current vs Target` gaps
  - visual emphasis for pass/fail states
- 🕒 Compare runs over time (improved / regressed / stable)
- 🗂️ Keep report history tidy (last 5 HTML reports)

## ⚡ Quick Setup (First Run)

One command to bootstrap everything:

```bash
pnpm quick-setup
```

This runs:

1. 📦 install workspace dependencies
2. 🧪 install Playwright Chromium runtime
3. 🛠️ build API workspace
4. 🖥️ build Web workspace
5. 📝 write setup metadata for local machine

Then start the app:

```bash
pnpm dev
```

## 🧰 Commands

- `pnpm dev` - start API + Web (auto free ports)
- `pnpm build` - build all workspaces
- `pnpm lint` - lint all workspaces
- `pnpm test` - run API tests (Vitest)
- `pnpm test:e2e` - run Web E2E tests (Playwright)
- `pnpm format` - run Prettier

Workspace examples:

- `pnpm --filter @hpa/api dev`
- `pnpm --filter @hpa/api test`
- `pnpm --filter @hpa/web dev`
- `pnpm --filter @hpa/web test:e2e`

## 🔗 Main Routes

- Web app URL: shown by `pnpm dev` (dynamic)
- API health: `GET /api/health`
- Analyze URL: `POST /api/analyze`
- Report HTML: `GET /api/report/:id`

Sample payload:

```json
{
  "url": "https://example.com",
  "bearerToken": "optional-token",
  "language": "en",
  "includeDiscoveredUrls": true
}
```

Note: if `language` is omitted, analysis defaults to `en`.

## 🧱 Project Structure

```text
apps/
  api/                # Fastify API (analysis engine + HTML report)
  web/                # Vue 3 frontend
packages/
  shared/             # Shared contracts and types
scripts/
  dev-auto-port.mjs   # Dynamic local ports
  quick-setup.mjs     # First-run bootstrap
reports/              # Generated reports + setup diagnostics
```

## 🔧 Environment Variables

- `API_HOST`, `API_PORT`, `WEB_PORT`
- `VITE_API_TARGET`
- `DEV_HOST`
- `HPA_REPORTS_DIR`
- `HPA_REQUEST_TIMEOUT_MS`

## 🧪 k6 Behavior (Runtime)

During analysis:

1. ✅ uses `k6` if available
2. 🛠️ attempts OS bootstrap if missing (`winget` / `choco` / `scoop` / `brew`)
3. 🛟 falls back to internal HTTP probe if k6 remains unavailable

Diagnostics:

- `reports/.setup/k6-bootstrap.json`

## ✅ Quality Stack

- TypeScript (API + Web + Shared)
- ESLint + Prettier
- Husky + lint-staged
- Vitest (API unit tests)
- Playwright (Web E2E smoke tests)

## 🆘 Troubleshooting

### “Analysis failed” in UI

Check:

- URL accessibility
- bearer token validity (if required)
- local Chrome installation
- installer tooling for k6 bootstrap
- setup logs at `reports/.setup/k6-bootstrap.json`

### Port already in use

Run:

```bash
pnpm dev
```

Auto-port launcher will choose free ports.

---

Built to make performance findings clear, actionable, and fast to fix 💙
