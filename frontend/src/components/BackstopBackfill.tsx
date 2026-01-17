import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect as Select } from '@/components/ui/native-select'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Loader2, CheckCircle2, XCircle, Info, DollarSign, Database, Zap, Copy, Check, Upload, FileText } from 'lucide-react'

type RangeType = 'days' | 'dateRange' | 'ledgerRange'

interface BackstopRow {
  action_type: string
  user_address: string
  pool_address: string | null
  lp_tokens: string | null
  shares: string | null
  q4w_exp: number | null
  ledger_sequence: number
}

interface EstimateResult {
  success: boolean
  gb: string
  cost: string
  warning?: string
  error?: string
}

interface SimulateResult {
  success: boolean
  rows_count: number
  estimated_cost: string
  rows: BackstopRow[]
  query?: string
  error?: string
}

interface EstimateResultWithQuery extends EstimateResult {
  query?: string
}

interface BackfillResult {
  success: boolean
  rows_fetched: number
  rows_inserted: number
  rows_updated: number
  estimated_cost: string
  error?: string
}

interface Config {
  backstop_contract: string
  action_types: string[]
}

function formatNumber(num: string | number | undefined | null): string {
  if (!num) return '-'
  const n = parseFloat(String(num))
  if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T'
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K'
  return n.toFixed(2)
}

function truncateAddress(address: string | undefined | null): string {
  if (!address) return '-'
  return address.substring(0, 8) + '...'
}

function getActionVariant(actionType: string): "deposit" | "withdraw" | "queue_withdrawal" | "dequeue_withdrawal" | "claim" | "donate" | "draw" | "gulp_emissions" | "secondary" {
  const variants: Record<string, "deposit" | "withdraw" | "queue_withdrawal" | "dequeue_withdrawal" | "claim" | "donate" | "draw" | "gulp_emissions"> = {
    'deposit': 'deposit',
    'withdraw': 'withdraw',
    'queue_withdrawal': 'queue_withdrawal',
    'dequeue_withdrawal': 'dequeue_withdrawal',
    'claim': 'claim',
    'donate': 'donate',
    'draw': 'draw',
    'gulp_emissions': 'gulp_emissions',
  }
  return variants[actionType] || 'secondary'
}


type Mode = 'query' | 'csv'

export function BackstopBackfill() {
  const [config, setConfig] = useState<Config | null>(null)
  const [mode, setMode] = useState<Mode>('query')
  const [rangeType, setRangeType] = useState<RangeType>('days')
  const [daysBack, setDaysBack] = useState('30')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [startLedger, setStartLedger] = useState('')
  const [endLedger, setEndLedger] = useState('')
  const [limit, setLimit] = useState('')

  const [estimating, setEstimating] = useState(false)
  const [simulating, setSimulating] = useState(false)
  const [running, setRunning] = useState(false)
  const [uploading, setUploading] = useState(false)

  const [estimateResult, setEstimateResult] = useState<EstimateResultWithQuery | null>(null)
  const [simulateResult, setSimulateResult] = useState<SimulateResult | null>(null)
  const [backfillResult, setBackfillResult] = useState<BackfillResult | null>(null)
  const [currentQuery, setCurrentQuery] = useState<string | null>(null)
  const [copiedQuery, setCopiedQuery] = useState(false)
  const [csvFile, setCsvFile] = useState<File | null>(null)

  useEffect(() => {
    loadConfig()
  }, [])

  async function loadConfig() {
    try {
      const response = await fetch('/api/bigquery/backstop/config')
      const data = await response.json()
      if (data.success) {
        setConfig(data)
      }
    } catch (error) {
      console.error('Failed to load config:', error)
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
    } else if (rangeType === 'ledgerRange') {
      if (startLedger) payload.startLedger = parseInt(startLedger)
      if (endLedger) payload.endLedger = parseInt(endLedger)
    }

    if (limit) payload.limit = parseInt(limit)
    return payload
  }

  async function getEstimate() {
    setEstimating(true)
    setEstimateResult(null)
    try {
      const response = await fetch('/api/bigquery/backstop/estimate', {
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
      setEstimateResult({ success: false, gb: '0', cost: '0', error: (error as Error).message })
    } finally {
      setEstimating(false)
    }
  }

  async function simulate() {
    setSimulating(true)
    setSimulateResult(null)
    try {
      const payload = buildPayload()
      if (!payload.limit) payload.limit = 100
      const response = await fetch('/api/bigquery/backstop/simulate', {
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
      setSimulateResult({ success: false, rows_count: 0, estimated_cost: '0', rows: [], error: (error as Error).message })
    } finally {
      setSimulating(false)
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
      const response = await fetch('/api/bigquery/backstop/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      })
      const data = await response.json()
      setBackfillResult(data)
    } catch (error) {
      setBackfillResult({ success: false, rows_fetched: 0, rows_inserted: 0, rows_updated: 0, estimated_cost: '0', error: (error as Error).message })
    } finally {
      setRunning(false)
    }
  }

  function reset() {
    setEstimateResult(null)
    setSimulateResult(null)
    setBackfillResult(null)
    setCsvFile(null)
  }

  async function copyQuery() {
    if (currentQuery) {
      await navigator.clipboard.writeText(currentQuery)
      setCopiedQuery(true)
      setTimeout(() => setCopiedQuery(false), 2000)
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file && file.type === 'text/csv') {
      setCsvFile(file)
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    const file = e.dataTransfer.files?.[0]
    if (file && (file.type === 'text/csv' || file.name.endsWith('.csv'))) {
      setCsvFile(file)
    }
  }

  async function uploadCsv() {
    if (!csvFile) return

    setUploading(true)
    setBackfillResult(null)
    try {
      const formData = new FormData()
      formData.append('file', csvFile)

      const response = await fetch('/api/bigquery/backstop/upload-csv', {
        method: 'POST',
        body: formData,
      })
      const data = await response.json()
      setBackfillResult(data)
    } catch (error) {
      setBackfillResult({
        success: false,
        rows_fetched: 0,
        rows_inserted: 0,
        rows_updated: 0,
        estimated_cost: '0',
        error: (error as Error).message
      })
    } finally {
      setUploading(false)
    }
  }

  return (
    <Card className="border-border/50">
      <CardHeader>
        <CardTitle className="text-2xl">Backstop Events Backfill</CardTitle>
        <CardDescription>
          Backfill backstop events (deposit, withdraw, queue_withdrawal, claim) from BigQuery
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Config Info */}
        <div className="grid grid-cols-2 gap-4 p-4 bg-muted/50 rounded-lg">
          <div>
            <p className="text-xs text-muted-foreground mb-1">Backstop Contract</p>
            <p className="font-mono text-xs">{truncateAddress(config?.backstop_contract)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">Action Types</p>
            <p className="text-sm">{config?.action_types?.join(', ') || 'Loading...'}</p>
          </div>
        </div>

        {/* Mode Toggle */}
        <div className="flex gap-2">
          <Button
            variant={mode === 'query' ? 'default' : 'outline'}
            onClick={() => setMode('query')}
            className="flex-1"
          >
            <Database className="mr-2 h-4 w-4" />
            Run Query
          </Button>
          <Button
            variant={mode === 'csv' ? 'default' : 'outline'}
            onClick={() => setMode('csv')}
            className="flex-1"
          >
            <Upload className="mr-2 h-4 w-4" />
            Upload CSV
          </Button>
        </div>

        {/* Form - only show in query mode */}
        {mode === 'query' && (
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
              <option value="ledgerRange">Ledger Range</option>
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

          {rangeType === 'ledgerRange' && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="startLedger">Start Ledger</Label>
                <Input
                  id="startLedger"
                  type="number"
                  value={startLedger}
                  onChange={(e) => setStartLedger(e.target.value)}
                  placeholder="e.g., 50000000"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endLedger">End Ledger</Label>
                <Input
                  id="endLedger"
                  type="number"
                  value={endLedger}
                  onChange={(e) => setEndLedger(e.target.value)}
                  placeholder="e.g., 51000000"
                />
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="limit">Row Limit (optional)</Label>
            <Input
              id="limit"
              type="number"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="Leave empty for all rows"
            />
            <p className="text-xs text-muted-foreground">Limit the number of rows to fetch (useful for testing)</p>
          </div>
        </div>
        )}

        {/* CSV Upload Mode */}
        {mode === 'csv' && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Run the query below in BigQuery Console and export results as CSV, then upload here.
            </p>

            {/* Query Display */}
            {currentQuery ? (
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
                <pre className="p-4 bg-muted rounded-lg text-xs font-mono overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap">
                  {currentQuery}
                </pre>
              </div>
            ) : (
              <Alert>
                <Info className="h-4 w-4" />
                <AlertTitle>No Query Yet</AlertTitle>
                <AlertDescription>
                  Switch to "Run Query" mode and click "Get Cost Estimate" to generate the query.
                </AlertDescription>
              </Alert>
            )}

            {/* CSV Drop Zone */}
            <div
              className={`relative border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                csvFile ? 'border-green-500 bg-green-500/10' : 'border-muted-foreground/25 hover:border-muted-foreground/50'
              }`}
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
            >
              {csvFile ? (
                <div className="space-y-2">
                  <FileText className="mx-auto h-8 w-8 text-green-500" />
                  <p className="text-sm font-medium">{csvFile.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {(csvFile.size / 1024).toFixed(1)} KB
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setCsvFile(null)}
                  >
                    Remove
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <Upload className="mx-auto h-8 w-8 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    Drop CSV file here or click to browse
                  </p>
                  <input
                    type="file"
                    accept=".csv"
                    onChange={handleFileChange}
                    className="absolute inset-0 opacity-0 cursor-pointer"
                  />
                </div>
              )}
            </div>

            {/* Upload Button */}
            <Button
              onClick={uploadCsv}
              disabled={!csvFile || uploading}
              className="w-full"
            >
              {uploading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Uploading...
                </>
              ) : (
                <>
                  <Upload className="mr-2 h-4 w-4" />
                  Upload and Process CSV
                </>
              )}
            </Button>
          </div>
        )}

        {/* Action Buttons - only in query mode */}
        {mode === 'query' && (
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
        )}

        {/* Query Display - in query mode after getting estimate */}
        {mode === 'query' && currentQuery && (
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
        {estimateResult && (
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

        {/* Simulate Result */}
        {simulateResult && simulateResult.success && (
          <Alert variant="success">
            <CheckCircle2 className="h-4 w-4" />
            <AlertTitle>Simulation Results (Preview)</AlertTitle>
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
                        <TableHead>Action</TableHead>
                        <TableHead>User</TableHead>
                        <TableHead>Pool</TableHead>
                        <TableHead className="text-right">LP Tokens</TableHead>
                        <TableHead className="text-right">Shares</TableHead>
                        <TableHead className="text-right">Ledger</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {simulateResult.rows.map((row, i) => (
                        <TableRow key={i}>
                          <TableCell>
                            <Badge variant={getActionVariant(row.action_type)}>
                              {row.action_type}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {truncateAddress(row.user_address)}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {truncateAddress(row.pool_address)}
                          </TableCell>
                          <TableCell className="text-right">
                            {formatNumber(row.lp_tokens)}
                          </TableCell>
                          <TableCell className="text-right">
                            {formatNumber(row.shares)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {row.ledger_sequence}
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
      </CardContent>
    </Card>
  )
}
