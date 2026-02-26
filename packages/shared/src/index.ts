export type LanguageCode = 'en' | 'es'

export interface AnalyzeRequest {
  url: string
  bearerToken?: string
  language: LanguageCode
}

export interface UrlInsights {
  pageUrl: string
  performanceScore: number
  firstContentfulPaintMs: number | null
  largestContentfulPaintMs: number | null
  timeToInteractiveMs: number | null
  totalByteWeightKb: number
  imageBytesKb: number
  videoBytesKb: number
  callTimeAvgMs: number | null
  callTimeP95Ms: number | null
  callsFailedRate: number | null
  issues: string[]
  suggestions: string[]
  finalScreenshotDataUrl: string | null
  rootCauses: Array<{
    cause: string
    evidence: string
    impact: 'high' | 'medium' | 'low'
    possibleFix: string
  }>
  opportunities: Array<{
    title: string
    detail: string
    score: number | null
  }>
  comparison?: {
    status: 'improved' | 'regressed' | 'stable' | 'new'
    previousAnalyzedAt: string | null
    deltas: {
      performanceScore: number | null
      firstContentfulPaintMs: number | null
      largestContentfulPaintMs: number | null
      timeToInteractiveMs: number | null
      totalByteWeightKb: number | null
      callTimeP95Ms: number | null
    }
  }
}

export interface AnalyzeResponse {
  reportId: string
  language: LanguageCode
  baseUrl: string
  discoveredUrls: string[]
  analyzedAt: string
  results: UrlInsights[]
  htmlReportPath: string
  previousReportId?: string | null
}
