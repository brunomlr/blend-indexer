import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect as Select } from '@/components/ui/native-select'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Loader2, CheckCircle2, XCircle, Info, DollarSign, Database, Zap, Copy, Check, TrendingUp } from 'lucide-react'

type RangeType = 'days' | 'dateRange'

interface PoolSnapshotsStats {
  total_rows: number
  unique_assets: number
  unique_pools: number
  earliest_date: string | null
  latest_date: string | null
}

interface EstimateResult {
  success: boolean
  bytes: number
  gb: string
  cost: string
  totalPools: number
  poolNames?: string[]
  warning?: string
  error?: string
}

interface BackfillResult {
  success: boolean
  rows_inserted: number
  rows_updated: number
  total: number
  estimated_cost?: string
  error?: string
  details?: {
    poolResults?: Array<{
      poolId: string
      poolName: string
      rows_inserted: number
      rows_updated: number
    }>
  }
}

interface EmissionApyResult {
  success: boolean
  output: string
  error?: string
  duration_ms: number
}

export function PoolSnapshotsBackfill() {
  const [stats, setStats] = useState<PoolSnapshotsStats | null>(null)
  const [loading, setLoading] = useState(true)

  // Range selection
  const [rangeType, setRangeType] = useState<RangeType>('days')
  const [daysBack, setDaysBack] = useState('30')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  // Operation states
  const [estimating, setEstimating] = useState(false)
  const [running, setRunning] = useState(false)
  const [estimateResult, setEstimateResult] = useState<EstimateResult | null>(null)
  const [backfillResult, setBackfillResult] = useState<BackfillResult | null>(null)
  const [copiedQuery, setCopiedQuery] = useState(false)

  // Emission APY backfill states
  const [runningEmissionApy, setRunningEmissionApy] = useState(false)
  const [emissionApyResult, setEmissionApyResult] = useState<EmissionApyResult | null>(null)

  useEffect(() => {
    loadStats()
  }, [])

  async function loadStats() {
    setLoading(true)
    try {
      const response = await fetch('/api/bigquery/pool-snapshots/stats')
      const data = await response.json()
      if (data.success) {
        setStats(data)
      }
    } catch (error) {
      console.error('Failed to load pool snapshots stats:', error)
    } finally {
      setLoading(false)
    }
  }

  function buildPayload() {
    const payload: Record<string, unknown> = {}

    if (rangeType === 'days') {
      const days = parseInt(daysBack)
      if (days && days > 0) {
        const end = new Date()
        const start = new Date()
        start.setDate(start.getDate() - days)
        payload.startDate = start.toISOString().split('T')[0]
        payload.endDate = end.toISOString().split('T')[0]
      }
    } else if (rangeType === 'dateRange') {
      if (startDate) payload.startDate = startDate
      if (endDate) payload.endDate = endDate
    }

    return payload
  }

  async function getEstimate() {
    setEstimating(true)
    setEstimateResult(null)
    try {
      const response = await fetch('/api/bigquery/estimate/pool/all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      })
      const data = await response.json()
      setEstimateResult(data)
    } catch (error) {
      setEstimateResult({ success: false, bytes: 0, gb: '0', cost: '0', totalPools: 0, error: (error as Error).message })
    } finally {
      setEstimating(false)
    }
  }

  async function runBackfill() {
    // Check if estimated cost is > $1 and ask for confirmation
    const estimatedCost = estimateResult?.cost ? parseFloat(estimateResult.cost) : 0
    if (estimatedCost > 1) {
      const confirmed = window.confirm(
        `Warning: This operation will cost approximately $${estimateResult?.cost} USD.\n\nAre you sure you want to proceed?`
      )
      if (!confirmed) return
    }

    setRunning(true)
    setBackfillResult(null)
    try {
      const response = await fetch('/api/bigquery/backfill/pool/all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      })
      const data = await response.json()
      setBackfillResult(data)

      // Reload stats if successful
      if (data.success && (data.rows_inserted > 0 || data.rows_updated > 0)) {
        await loadStats()
      }
    } catch (error) {
      setBackfillResult({ success: false, rows_inserted: 0, rows_updated: 0, total: 0, error: (error as Error).message })
    } finally {
      setRunning(false)
    }
  }

  function reset() {
    setEstimateResult(null)
    setBackfillResult(null)
  }

  async function copyPoolNames() {
    if (estimateResult?.poolNames) {
      await navigator.clipboard.writeText(estimateResult.poolNames.join('\n'))
      setCopiedQuery(true)
      setTimeout(() => setCopiedQuery(false), 2000)
    }
  }

  async function runEmissionApyBackfill() {
    setRunningEmissionApy(true)
    setEmissionApyResult(null)
    try {
      const response = await fetch('/api/emission-apy/backfill/lending', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const data = await response.json()
      setEmissionApyResult(data)
    } catch (error) {
      setEmissionApyResult({
        success: false,
        output: '',
        error: (error as Error).message,
        duration_ms: 0,
      })
    } finally {
      setRunningEmissionApy(false)
    }
  }

  if (loading) {
    return (
      <Card className="border-border/50">
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="border-border/50">
      <CardHeader>
        <CardTitle className="text-2xl flex items-center gap-2">
          <Database className="h-6 w-6" />
          Pool Snapshots Backfill
        </CardTitle>
        <CardDescription>
          Backfill pool reserve data (b_rate, d_rate, b_supply, d_supply) from BigQuery for all Blend pools
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4 bg-muted/50 rounded-lg">
          <div>
            <p className="text-xs text-muted-foreground mb-1">Total Snapshots</p>
            <p className="text-lg font-bold">{stats?.total_rows?.toLocaleString() || 0}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">Pools</p>
            <p className="text-lg font-bold">{stats?.unique_pools || 0}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">Assets</p>
            <p className="text-lg font-bold">{stats?.unique_assets || 0}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">Date Range</p>
            <p className="text-sm">
              {stats?.earliest_date && stats?.latest_date
                ? `${stats.earliest_date} to ${stats.latest_date}`
                : 'No data yet'}
            </p>
          </div>
        </div>

        {/* Range Selection */}
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="rangeType">Range Type</Label>
            <Select
              id="rangeType"
              value={rangeType}
              onChange={(e) => setRangeType(e.target.value as RangeType)}
            >
              <option value="days">Days Back (from today)</option>
              <option value="dateRange">Specific Date Range</option>
            </Select>
          </div>

          {rangeType === 'days' && (
            <div className="space-y-2">
              <Label htmlFor="daysBack">Days Back</Label>
              <Input
                id="daysBack"
                type="number"
                value={daysBack}
                onChange={(e) => setDaysBack(e.target.value)}
                min="1"
              />
              <p className="text-xs text-muted-foreground">Number of days to look back from today</p>
            </div>
          )}

          {rangeType === 'dateRange' && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="startDate">Start Date</Label>
                <Input
                  id="startDate"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endDate">End Date</Label>
                <Input
                  id="endDate"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="grid grid-cols-2 gap-3">
          <Button
            variant="secondary"
            onClick={getEstimate}
            disabled={estimating}
          >
            {estimating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Estimating...
              </>
            ) : (
              <>
                <DollarSign className="mr-2 h-4 w-4" />
                Get Cost Estimate
              </>
            )}
          </Button>
          <Button
            onClick={runBackfill}
            disabled={running}
          >
            {running ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Running...
              </>
            ) : (
              <>
                <Zap className="mr-2 h-4 w-4" />
                Run Backfill
              </>
            )}
          </Button>
        </div>

        {/* Estimate Result */}
        {estimateResult && estimateResult.success && (
          <Alert variant="info">
            <Info className="h-4 w-4" />
            <AlertTitle>Cost Estimate</AlertTitle>
            <AlertDescription>
              <div className="grid grid-cols-4 gap-4 mt-3">
                <div className="text-center p-3 bg-background rounded-lg">
                  <p className="text-xs text-muted-foreground">Data to Process</p>
                  <p className="text-2xl font-bold">{estimateResult.gb}</p>
                  <p className="text-xs text-muted-foreground">GB</p>
                </div>
                <div className="text-center p-3 bg-background rounded-lg">
                  <p className="text-xs text-muted-foreground">Estimated Cost</p>
                  <p className="text-2xl font-bold">${estimateResult.cost}</p>
                  <p className="text-xs text-muted-foreground">USD</p>
                </div>
                <div className="text-center p-3 bg-background rounded-lg">
                  <p className="text-xs text-muted-foreground">Pools</p>
                  <p className="text-2xl font-bold">{estimateResult.totalPools}</p>
                  <p className="text-xs text-muted-foreground">discovered</p>
                </div>
                <div className="text-center p-3 bg-background rounded-lg">
                  <p className="text-xs text-muted-foreground">Free Tier</p>
                  <p className="text-2xl font-bold">1 TB</p>
                  <p className="text-xs text-muted-foreground">per month</p>
                </div>
              </div>
              {estimateResult.poolNames && estimateResult.poolNames.length > 0 && (
                <div className="mt-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-medium">Pools to backfill:</p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={copyPoolNames}
                      className="h-8"
                    >
                      {copiedQuery ? (
                        <>
                          <Check className="mr-1 h-3 w-3" />
                          Copied!
                        </>
                      ) : (
                        <>
                          <Copy className="mr-1 h-3 w-3" />
                          Copy
                        </>
                      )}
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {estimateResult.poolNames.map((name, i) => (
                      <span
                        key={i}
                        className="px-2 py-1 text-xs bg-background rounded border"
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {estimateResult.warning && (
                <p className="mt-3 text-yellow-500 text-sm">{estimateResult.warning}</p>
              )}
            </AlertDescription>
          </Alert>
        )}

        {estimateResult && !estimateResult.success && (
          <Alert variant="destructive">
            <XCircle className="h-4 w-4" />
            <AlertTitle>Estimate Failed</AlertTitle>
            <AlertDescription>{estimateResult.error || 'Unknown error'}</AlertDescription>
          </Alert>
        )}

        {/* Backfill Result */}
        {backfillResult && backfillResult.success && (
          <Alert variant="success">
            <CheckCircle2 className="h-4 w-4" />
            <AlertTitle>Backfill Successful</AlertTitle>
            <AlertDescription>
              <div className="space-y-1 mt-2">
                <p>Total rows: <strong>{backfillResult.total.toLocaleString()}</strong></p>
                <p>Rows inserted: <strong>{backfillResult.rows_inserted.toLocaleString()}</strong></p>
                <p>Rows updated: <strong>{backfillResult.rows_updated.toLocaleString()}</strong></p>
              </div>
              {backfillResult.details?.poolResults && backfillResult.details.poolResults.length > 0 && (
                <div className="mt-4">
                  <p className="text-sm font-medium mb-2">Per-pool results:</p>
                  <div className="max-h-48 overflow-auto space-y-1 text-xs">
                    {backfillResult.details.poolResults.map((pool, i) => (
                      <div key={i} className="flex justify-between p-2 bg-background rounded">
                        <span>{pool.poolName}</span>
                        <span>+{pool.rows_inserted} / ~{pool.rows_updated}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <Button variant="secondary" className="mt-4" onClick={reset}>
                Run Another
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {backfillResult && !backfillResult.success && (
          <Alert variant="destructive">
            <XCircle className="h-4 w-4" />
            <AlertTitle>Backfill Failed</AlertTitle>
            <AlertDescription>
              <p>{backfillResult.error || 'Unknown error'}</p>
              <Button variant="secondary" className="mt-4" onClick={reset}>
                Try Again
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {/* Emission APY Backfill Section */}
        {backfillResult?.success && (
          <div className="border-t pt-6 mt-6">
            <div className="flex items-center gap-2 mb-4">
              <TrendingUp className="h-5 w-5" />
              <h3 className="text-lg font-semibold">Calculate Lending Emission APY</h3>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              After backfilling pool snapshots, run this to calculate historical BLND emission APY for lending supply/borrow using the b_supply/d_supply values.
            </p>
            <Button
              onClick={runEmissionApyBackfill}
              disabled={runningEmissionApy}
              variant="secondary"
            >
              {runningEmissionApy ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Calculating Emission APY...
                </>
              ) : (
                <>
                  <TrendingUp className="mr-2 h-4 w-4" />
                  Calculate Lending Emission APY
                </>
              )}
            </Button>

            {emissionApyResult && emissionApyResult.success && (
              <Alert variant="success" className="mt-4">
                <CheckCircle2 className="h-4 w-4" />
                <AlertTitle>Emission APY Calculated</AlertTitle>
                <AlertDescription>
                  <p className="text-sm">Completed in {(emissionApyResult.duration_ms / 1000).toFixed(1)}s</p>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                      View output
                    </summary>
                    <pre className="mt-2 max-h-48 overflow-auto text-xs bg-background p-2 rounded whitespace-pre-wrap">
                      {emissionApyResult.output}
                    </pre>
                  </details>
                </AlertDescription>
              </Alert>
            )}

            {emissionApyResult && !emissionApyResult.success && (
              <Alert variant="destructive" className="mt-4">
                <XCircle className="h-4 w-4" />
                <AlertTitle>Emission APY Calculation Failed</AlertTitle>
                <AlertDescription>
                  <p>{emissionApyResult.error || 'Unknown error'}</p>
                  {emissionApyResult.output && (
                    <pre className="mt-2 max-h-32 overflow-auto text-xs bg-background p-2 rounded whitespace-pre-wrap">
                      {emissionApyResult.output}
                    </pre>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
