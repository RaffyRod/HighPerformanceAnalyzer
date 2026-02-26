# High Performance Analyzer

High Performance Analyzer is a full-stack monorepo that discovers key URLs from a target website, runs performance analysis, and generates an HTML report with findings, root causes, and suggestions.

It combines:

- Lighthouse audits (browser performance diagnostics)
- HTTP load checks (k6 when available, internal fallback when not)
- Multilingual UI/reporting (English and Spanish)
- Historical comparison between runs

## What You Get

- URL discovery from the provided base URL (same origin, top pages)
- Performance insights per page:
  - Performance score
  - FCP, LCP, TTI
  - Payload size (including image/media weight)
  - Request latency and failure rate
- Enhanced HTML report with:
  - Root causes and suggested fixes
  - Opportunities from Lighthouse
  - Final page screenshot evidence
  - Before/after deltas versus the previous run
- Report retention policy:
  - Reports are stored in `reports/`
  - File naming uses execution date: `analysis-YYYY-MM-DD.html`
  - Same-day runs replace the same file
  - Only the latest 5 HTML reports are retained

## Monorepo Structure

```text
apps/
  api/        # Fastify + TypeScript backend
  web/        # Vue 3 + TypeScript frontend
packages/
  shared/     # Shared TypeScript contracts
scripts/
  dev-auto-port.mjs  # Auto-detects free ports for API and Web
reports/      # Generated HTML reports + history
```

## Prerequisites

- Node.js 20+ (recommended)
- pnpm 10+
- Chrome installed (required by Lighthouse)

Optional (recommended):

- `k6` installed globally for native load testing

> No worries if `k6` is missing on first run. The backend now attempts one-time auto-setup and falls back to an internal probe if installation is unavailable.

## Quick Start

1. Install dependencies:

```bash
pnpm install
```

2. Start the app (API + Web with auto free-port detection):

```bash
pnpm dev
```

3. Open the frontend URL printed in terminal, submit:
   - Target URL
   - Optional Bearer token
   - Language (ES/EN toggle)

## k6 First-Run Auto Setup

When analysis needs load metrics, backend checks if `k6` exists:

1. If `k6` is available in `PATH`, it is used directly.
2. If missing, backend tries to install it automatically (platform-dependent):
   - Windows: `winget`, then `choco`, then `scoop`
   - macOS: `brew`
3. If installation still fails, analysis continues using the internal HTTP fallback probe (so analysis does not fail).

Bootstrap state is recorded in:

- `reports/.setup/k6-bootstrap.json`

## API Endpoints

- `GET /api/health` - Health check
- `POST /api/analyze` - Starts a full analysis run
- `GET /api/report/:id` - Returns generated HTML report

Example request:

```json
{
  "url": "https://example.com",
  "bearerToken": "your-token-if-needed",
  "language": "en"
}
```

## Development Commands

- `pnpm dev` - Run web + api in dev mode with automatic ports
- `pnpm build` - Build all workspaces
- `pnpm lint` - Lint all workspaces
- `pnpm format` - Format repository files

Workspace-specific examples:

- `pnpm --filter @hpa/api dev`
- `pnpm --filter @hpa/web dev`
- `pnpm --filter @hpa/api build`
- `pnpm --filter @hpa/web build`

## Troubleshooting

### "Analysis failed..." in the UI

Common causes:

- Target URL is not reachable
- Auth token is invalid/expired
- Chrome is not installed or blocked
- `k6` unavailable and installer cannot run in current environment

What to check:

1. Verify URL manually in browser
2. Re-run with a valid Bearer token if endpoint is protected
3. Confirm Chrome is installed
4. Confirm package managers are available:
   - Windows: `winget --version`, `choco --version`, or `scoop --version`
   - macOS: `brew --version`
5. Read `reports/.setup/k6-bootstrap.json` for auto-setup diagnostics

### Ports already in use

Use:

```bash
pnpm dev
```

The provided launcher automatically finds free ports for both API and Web.

## Quality and Tooling

- TypeScript across frontend/backend/shared package
- ESLint + Prettier
- Husky + lint-staged pre-commit checks
- Multilingual UI and report labels (`en` / `es`)

## Notes

- Reports are intentionally retained as latest 5 HTML files only.
- Same-day report names are deterministic by date and overwrite previous file for that day.
- Historical comparison data is persisted in `reports/history/`.
