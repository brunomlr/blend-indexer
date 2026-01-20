import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect as Select } from '@/components/ui/native-select'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Loader2, CheckCircle2, XCircle, Info, Copy, Check, Database, DollarSign, Zap, Percent } from 'lucide-react'

type RangeType = 'days' | 'dateRange'

interface BackstopQ4wStats {
  total_rows: number
  earliest_date: string | null
  latest_date: string | null
  unique_pools: number
  backstop_contract: string
}

interface BackstopQ4wRow {
  pool_address: string
  snapshot_date: string
  shares: string
  tokens: string
  q4w: string
  q4w_pct: string | number
}

interface PoolQ4wData {
  pool_address: string
  snapshot_date: string
  q4w_pct: string | number
  shares: string
  tokens: string
  q4w: string
}

interface EstimateResult {
  success: boolean
  bytes: number
  gb: string
  cost: string
  query: string
  error?: string
}

interface SimulateResult {
  success: boolean
  rows_count: number
  rows: BackstopQ4wRow[]
  estimated_cost: string
  query: string
  error?: string
}

interface BackfillResult {
  success: boolean
  rows_fetched: number
  rows_inserted: number
  rows_updated: number
  estimated_cost: string
  error?: string
}

function truncateAddress(address: string | undefined | null): string {
  if (!address) return '-'
  return address.substring(0, 8) + '...' + address.substring(address.length - 4)
}

function formatBigNumber(value: string | undefined | null): string {
  if (!value) return '0'
  const num = BigInt(value)
  // Convert from 7 decimals (stroop) to human readable
  const whole = num / BigInt(10000000)
  return whole.toLocaleString()
}

export function BackstopQ4wBackfill() {
  const [stats, setStats] = useState<BackstopQ4wStats | null>(null)
  const [poolData, setPoolData] = useState<PoolQ4wData[]>([])
  const [loading, setLoading] = useState(true)

  // Range selection
  const [rangeType, setRangeType] = useState<RangeType>('days')
  const [daysBack, setDaysBack] = useState('30')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [poolFilter, setPoolFilter] = useState('')

  // Query state
  const [estimating, setEstimating] = useState(false)
  const [simulating, setSimulating] = useState(false)
  const [running, setRunning] = useState(false)
  const [estimateResult, setEstimateResult] = useState<EstimateResult | null>(null)
  const [simulateResult, setSimulateResult] = useState<SimulateResult | null>(null)
  const [backfillResult, setBackfillResult] = useState<BackfillResult | null>(null)
  const [currentQuery, setCurrentQuery] = useState<string | null>(null)
  const [copiedQuery, setCopiedQuery] = useState(false)

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    setLoading(true)
    try {
      const [statsRes, dataRes] = await Promise.all([
        fetch('/api/bigquery/backstop-q4w/stats'),
        fetch('/api/bigquery/backstop-q4w/data'),
      ])

      const statsData = await statsRes.json()
      const poolDataResult = await dataRes.json()

      if (statsData.success) {
        setStats(statsData)
      }
      if (poolDataResult.success) {
        setPoolData(poolDataResult.data)
      }
    } catch (error) {
      console.error('Failed to load backstop Q4W data:', error)
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

    if (poolFilter) {
      payload.poolAddress = poolFilter
    }

    return payload
  }

  async function getEstimate() {
    setEstimating(true)
    setEstimateResult(null)
    try {
      const response = await fetch('/api/bigquery/backstop-q4w/estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      })
      const data = await response.json()
      setEstimateResult(data)
      if (data.query) {
        setCurrentQuery(data.query)
      }
    } catch (error) {
      setEstimateResult({ success: false, bytes: 0, gb: '0', cost: '0', query: '', error: (error as Error).message })
    } finally {
      setEstimating(false)
    }
  }

  async function simulate() {
    setSimulating(true)
    setSimulateResult(null)
    try {
      const payload = { ...buildPayload(), limit: 100 }
      const response = await fetch('/api/bigquery/backstop-q4w/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await response.json()
      setSimulateResult(data)
      if (data.query) {
        setCurrentQuery(data.query)
      }
    } catch (error) {
      setSimulateResult({ success: false, rows_count: 0, rows: [], estimated_cost: '0', query: '', error: (error as Error).message })
    } finally {
      setSimulating(false)
    }
  }

  async function runBackfill() {
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
      const response = await fetch('/api/bigquery/backstop-q4w/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      })
      const data = await response.json()
      setBackfillResult(data)

      if (data.success && (data.rows_inserted > 0 || data.rows_updated > 0)) {
        await loadData()
      }
    } catch (error) {
      setBackfillResult({ success: false, rows_fetched: 0, rows_inserted: 0, rows_updated: 0, estimated_cost: '0', error: (error as Error).message })
    } finally {
      setRunning(false)
    }
  }

  async function copyQuery() {
    if (currentQuery) {
      await navigator.clipboard.writeText(currentQuery)
      setCopiedQuery(true)
      setTimeout(() => setCopiedQuery(false), 2000)
    }
  }

  function reset() {
    setEstimateResult(null)
    setSimulateResult(null)
    setBackfillResult(null)
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
          <Percent className="h-6 w-6" />
          Backstop Q4W Percentage Backfill
        </CardTitle>
        <CardDescription>
          Import historical backstop pool Q4W (Queue for Withdrawal) percentage data from Hubble BigQuery
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-4 gap-4 p-4 bg-muted/50 rounded-lg">
          <div>
            <p className="text-xs text-muted-foreground mb-1">Backstop Contract</p>
            <p className="font-mono text-xs">{truncateAddress(stats?.backstop_contract)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">Total Snapshots</p>
            <p className="text-lg font-bold">{stats?.total_rows || 0}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">Unique Pools</p>
            <p className="text-lg font-bold">{stats?.unique_pools || 0}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">Date Range</p>
            <p className="text-sm">
              {stats?.earliest_date && stats?.latest_date
                ? `${stats.earliest_date} - ${stats.latest_date}`
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

          <div className="space-y-2">
            <Label htmlFor="poolFilter">Pool Filter (optional)</Label>
            <Input
              id="poolFilter"
              type="text"
              value={poolFilter}
              onChange={(e) => setPoolFilter(e.target.value)}
              placeholder="C... (leave empty for all pools)"
            />
            <p className="text-xs text-muted-foreground">Filter to a specific pool address</p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="grid grid-cols-3 gap-3">
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
            variant="secondary"
            onClick={simulate}
            disabled={simulating}
          >
            {simulating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading...
              </>
            ) : (
              <>
                <Database className="mr-2 h-4 w-4" />
                Preview Data
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

        {/* Query Display */}
        {currentQuery && (
          <div className="relative">
            <div className="flex items-center justify-between mb-2">
              <Label>BigQuery Query</Label>
              <Button
                variant="ghost"
                size="sm"
                onClick={copyQuery}
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
            <pre className="p-4 bg-muted rounded-lg text-xs font-mono overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">
              {currentQuery}
            </pre>
          </div>
        )}

        {/* Estimate Result */}
        {estimateResult && estimateResult.success && (
          <Alert variant="info">
            <Info className="h-4 w-4" />
            <AlertTitle>Cost Estimate</AlertTitle>
            <AlertDescription>
              <div className="grid grid-cols-3 gap-4 mt-3">
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
                  <p className="text-xs text-muted-foreground">Free Tier</p>
                  <p className="text-2xl font-bold">1 TB</p>
                  <p className="text-xs text-muted-foreground">per month</p>
                </div>
              </div>
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

        {/* Simulate Result */}
        {simulateResult && simulateResult.success && (
          <Alert variant="success">
            <CheckCircle2 className="h-4 w-4" />
            <AlertTitle>Preview Results</AlertTitle>
            <AlertDescription>
              <p className="mb-3">
                Rows fetched: <strong>{simulateResult.rows_count}</strong>
                <span className="text-muted-foreground text-xs ml-2">
                  (estimated cost: ${simulateResult.estimated_cost})
                </span>
              </p>
              {simulateResult.rows && simulateResult.rows.length > 0 ? (
                <div className="max-h-72 overflow-auto rounded-lg border bg-background">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Pool</TableHead>
                        <TableHead className="text-right">Q4W %</TableHead>
                        <TableHead className="text-right">Shares</TableHead>
                        <TableHead className="text-right">Q4W Shares</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {simulateResult.rows.map((row, i) => (
                        <TableRow key={i}>
                          <TableCell className="font-mono text-xs">
                            {row.snapshot_date}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {truncateAddress(row.pool_address)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {Number(row.q4w_pct).toFixed(2)}%
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {formatBigNumber(row.shares)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {formatBigNumber(row.q4w)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="text-center text-muted-foreground py-4">No data found</p>
              )}
            </AlertDescription>
          </Alert>
        )}

        {simulateResult && !simulateResult.success && (
          <Alert variant="destructive">
            <XCircle className="h-4 w-4" />
            <AlertTitle>Preview Failed</AlertTitle>
            <AlertDescription>{simulateResult.error || 'Unknown error'}</AlertDescription>
          </Alert>
        )}

        {/* Backfill Result */}
        {backfillResult && backfillResult.success && (
          <Alert variant="success">
            <CheckCircle2 className="h-4 w-4" />
            <AlertTitle>Backfill Successful</AlertTitle>
            <AlertDescription>
              <div className="space-y-1 mt-2">
                <p>Rows fetched: <strong>{backfillResult.rows_fetched.toLocaleString()}</strong></p>
                <p>Rows inserted: <strong>{backfillResult.rows_inserted.toLocaleString()}</strong></p>
                <p>Rows updated: <strong>{backfillResult.rows_updated.toLocaleString()}</strong></p>
                <p>Estimated cost: <strong>${backfillResult.estimated_cost}</strong></p>
              </div>
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

        {/* Current Pool Data */}
        {poolData.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4" />
              <p className="text-sm font-medium">Latest Q4W by Pool</p>
            </div>
            <div className="max-h-64 overflow-auto rounded-lg border bg-background">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Pool</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Q4W %</TableHead>
                    <TableHead className="text-right">Total Shares</TableHead>
                    <TableHead className="text-right">Q4W Shares</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {poolData.map((row, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono text-xs">
                        {truncateAddress(row.pool_address)}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {row.snapshot_date}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        <span className={Number(row.q4w_pct) > 10 ? 'text-yellow-500' : Number(row.q4w_pct) > 25 ? 'text-red-500' : ''}>
                          {Number(row.q4w_pct).toFixed(2)}%
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {formatBigNumber(row.shares)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {formatBigNumber(row.q4w)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
