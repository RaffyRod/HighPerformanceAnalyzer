# High Performance Analyzer

High Performance Analyzer is a TypeScript monorepo that runs Lighthouse and load checks for a target URL, then produces a bilingual, actionable HTML report focused on performance diagnosis and remediation.

## Core Capabilities

- Analyze a single URL or discovered internal URLs (same origin)
- Lighthouse performance audit with key web vitals (FCP, LCP, TTI, payload)
- Load metrics with k6 (or internal fallback when k6 is unavailable)
- Bilingual UX and reports (`en` / `es`)
- Executive report view with:
  - health badges and score summary
  - gap analysis (`Current` vs `Target`)
  - fail-first opportunity prioritization
  - colored status emphasis (green pass / red fail)
- Historical comparison against previous runs
- Report retention policy (last 5 HTML reports)

## Quick Setup (First Run)

For a clean first-time setup, run:

```bash
pnpm quick-setup
```

This command performs the full initial bootstrap:

1. installs all workspace dependencies
2. installs Playwright Chromium runtime
3. builds API workspace
4. builds web workspace
5. writes setup completion metadata

After setup:

```bash
pnpm dev
```

## Standard Commands

- `pnpm dev` - start API + Web with auto-selected free ports
- `pnpm build` - build all workspaces
- `pnpm lint` - run lint across workspaces
- `pnpm test` - run API unit tests (Vitest)
- `pnpm test:e2e` - run web E2E tests (Playwright)
- `pnpm format` - format repository with Prettier

Workspace-level examples:

- `pnpm --filter @hpa/api dev`
- `pnpm --filter @hpa/api test`
- `pnpm --filter @hpa/web dev`
- `pnpm --filter @hpa/web test:e2e`

## API and Routes

- Web app URL: printed by `pnpm dev` (dynamic port)
- Health endpoint: `GET /api/health`
- Analyze endpoint: `POST /api/analyze`
- HTML report endpoint: `GET /api/report/:id`

Example payload:

```json
{
  "url": "https://example.com",
  "bearerToken": "optional-token",
  "language": "en",
  "includeDiscoveredUrls": true
}
```

## Project Structure

```text
apps/
  api/                # Fastify API (analysis engine + report generation)
  web/                # Vue 3 frontend
packages/
  shared/             # Shared contracts and types
scripts/
  dev-auto-port.mjs   # Dynamic port allocation for local dev
  quick-setup.mjs     # First-run bootstrap automation
reports/              # Generated reports, history, and setup diagnostics
```

## Environment Configuration

Supported environment variables:

- `API_HOST`, `API_PORT`, `WEB_PORT`
- `VITE_API_TARGET`
- `DEV_HOST`
- `HPA_REPORTS_DIR`
- `HPA_REQUEST_TIMEOUT_MS`

## k6 Runtime Behavior

At analysis time:

1. uses `k6` when available
2. attempts OS-specific install when missing (`winget` / `choco` / `scoop` / `brew`)
3. falls back to internal HTTP load probe if k6 is still unavailable

Diagnostic file:

- `reports/.setup/k6-bootstrap.json`

## Quality and Tooling

- TypeScript across frontend/backend/shared
- ESLint + Prettier
- Husky + lint-staged pre-commit checks
- Vitest for API unit tests
- Playwright for end-to-end smoke coverage

## Troubleshooting

### Analysis failure in UI

Validate:

- target URL accessibility
- bearer token validity (if required)
- local Chrome availability
- package manager tools for k6 bootstrap (if k6 missing)
- setup diagnostics in `reports/.setup/k6-bootstrap.json`

### Port conflicts

Use:

```bash
pnpm dev
```

The dev launcher automatically resolves free ports.

---

Designed for clear performance diagnostics and fast remediation workflows.
