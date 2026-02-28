# High Performance Analyzer 🚀

Analyze any website with Lighthouse + load checks, discover internal URLs, and generate a friendly HTML report with actionable fixes.

## ✨ Features

- 🌐 Analyze one URL or discovered internal URLs (same domain)
- ⚡ Lighthouse metrics (Performance score, FCP, LCP, TTI)
- 📡 Request latency + failure insights (k6 or internal fallback)
- 🌍 Bilingual UI/report (`en` / `es`)
- 📊 Friendly HTML report (score overview, priorities, causes, actions)
- 🧭 Executive readability layer per URL:
  - Overall status badge (`Healthy` / `Needs attention` / `Critical`)
  - Gap table (`Current` vs `Target` + `% gap`)
  - "Focus first" priorities to act quickly
- 🟥🟩 Opportunity status colors:
  - Red when metric fails expected threshold
  - Green when metric passes expected threshold
- ✅❌ Opportunity readability upgrades:
  - Fail items listed first, pass items after
  - Compact side-by-side cards on desktop
  - Bright status emphasis for `Status` and `Current`
  - Prominent "Open HTML report" CTA in app results
- 🧪 Analyzer quality upgrades:
  - Lighthouse + k6 run in parallel per URL to reduce end-to-end analysis time
  - k6 uses thresholds (`http_req_failed`, `http_req_duration`) and richer trend stats
  - Network requests use timeouts to avoid hanging analysis runs
  - Safer k6 script generation with escaped runtime values
- 🕒 Before/after comparison against previous runs
- 🗂️ Report retention:
  - Stored in `reports/`
  - Naming: `analysis-YYYY-MM-DD.html`
  - Same-day runs overwrite that day file
  - Keep only latest 5 HTML reports

## ⚡ Quick Setup (Recommended)

### 1) Install dependencies

```bash
pnpm install
```

### 2) Start the full app (API + Web)

```bash
pnpm dev
```

### 3) Open the app URL shown in terminal

- Fill target URL
- Add Bearer token if needed
- Select language
- Run analysis ✅

## 🔗 Important Routes

- Web app: printed by `pnpm dev` (auto-port)
- API health: `GET /api/health`
- Analyze: `POST /api/analyze`
- Report by id: `GET /api/report/:id`

Example payload:

```json
{
  "url": "https://example.com",
  "bearerToken": "your-token-if-needed",
  "language": "en",
  "includeDiscoveredUrls": true
}
```

## 🧱 Project Structure

```text
apps/
  api/        # Fastify + TypeScript API
  web/        # Vue 3 + TypeScript frontend
packages/
  shared/     # Shared contracts/types
scripts/
  dev-auto-port.mjs  # Finds free ports automatically
reports/      # Generated reports + history + setup logs
```

## 🔧 Environment & Dynamic Paths

The app is portable across machines and supports dynamic config:

- `API_HOST`, `API_PORT`, `WEB_PORT`
- `VITE_API_TARGET`
- `DEV_HOST`
- `HPA_REPORTS_DIR` (custom reports directory)

If not provided, safe defaults are used.

## 🧪 k6 First-Run Behavior

When running analysis:

1. Uses `k6` if available in `PATH`
2. If missing, tries one-time install:
   - Windows: `winget` → `choco` → `scoop`
   - macOS: `brew`
3. If still unavailable, continues with internal HTTP fallback (analysis does not break)

Setup diagnostics:

- `reports/.setup/k6-bootstrap.json`

## 🛠️ Dev Commands

- `pnpm dev` - Run API + Web with auto free ports
- `pnpm build` - Build all workspaces
- `pnpm lint` - Lint all workspaces
- `pnpm test` - Run API unit tests (Vitest)
- `pnpm test:e2e` - Run web E2E tests (Playwright)
- `pnpm format` - Format repository

Workspace examples:

- `pnpm --filter @hpa/api dev`
- `pnpm --filter @hpa/web dev`
- `pnpm --filter @hpa/api build`
- `pnpm --filter @hpa/web build`
- `pnpm --filter @hpa/api test`
- `pnpm --filter @hpa/web test:e2e`

## 🆘 Troubleshooting

### "Analysis failed..." in UI

Check:

- URL is reachable
- Bearer token is valid (if required)
- Chrome is installed
- k6 installer tools are available (`winget`, `choco`, `scoop`, or `brew`)
- `reports/.setup/k6-bootstrap.json` for setup details

### Ports already in use

Just run:

```bash
pnpm dev
```

It auto-finds available ports.

## ✅ Tooling

- TypeScript (frontend + backend + shared)
- ESLint + Prettier
- Husky + lint-staged pre-commit checks

---

Built to make performance diagnostics easier to understand and faster to act on. 💙
