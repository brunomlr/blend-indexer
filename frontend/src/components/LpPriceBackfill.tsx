import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect as Select } from '@/components/ui/native-select'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Loader2, CheckCircle2, XCircle, Info, Copy, Check, Upload, FileText, TrendingUp, Database, DollarSign, Zap } from 'lucide-react'

type RangeType = 'days' | 'dateRange'
type Mode = 'query' | 'upload'

interface LpPriceStats {
  totalPrices: number
  earliestDate: string | null
  latestDate: string | null
  lp_token_address: string
}

interface LpPriceRow {
  price_date: string
  lp_token_price: number
  ledger_sequence?: number
}

interface LpPriceData {
  price_date: string
  lp_token_price: number
  source: string
}

interface UploadResult {
  success: boolean
  rows_processed: number
  rows_inserted: number
  rows_skipped: number
  dry_run: boolean
  error?: string
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
  rows: LpPriceRow[]
  estimated_cost: string
  query: string
  error?: string
}

interface BackfillResult {
  success: boolean
  rows_fetched: number
  rows_inserted: number
  rows_updated: number
  rows_skipped: number
  estimated_cost: string
  error?: string
}

function truncateAddress(address: string | undefined | null): string {
  if (!address) return '-'
  return address.substring(0, 8) + '...' + address.substring(address.length - 4)
}

export function LpPriceBackfill() {
  const [stats, setStats] = useState<LpPriceStats | null>(null)
  const [priceData, setPriceData] = useState<LpPriceData[]>([])
  const [loading, setLoading] = useState(true)

  // Mode and range selection
  const [mode, setMode] = useState<Mode>('query')
  const [rangeType, setRangeType] = useState<RangeType>('days')
  const [daysBack, setDaysBack] = useState('30')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  // Query mode state
  const [estimating, setEstimating] = useState(false)
  const [simulating, setSimulating] = useState(false)
  const [running, setRunning] = useState(false)
  const [estimateResult, setEstimateResult] = useState<EstimateResult | null>(null)
  const [simulateResult, setSimulateResult] = useState<SimulateResult | null>(null)
  const [backfillResult, setBackfillResult] = useState<BackfillResult | null>(null)
  const [currentQuery, setCurrentQuery] = useState<string | null>(null)
  const [copiedQuery, setCopiedQuery] = useState(false)

  // Upload mode state
  const [uploading, setUploading] = useState(false)
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null)
  const [jsonFile, setJsonFile] = useState<File | null>(null)
  const [previewMode, setPreviewMode] = useState(true)

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    setLoading(true)
    try {
      const [statsRes, dataRes] = await Promise.all([
        fetch('/api/bigquery/lp-prices/stats'),
        fetch('/api/bigquery/lp-prices/data?limit=20'),
      ])

      const statsData = await statsRes.json()
      const priceDataResult = await dataRes.json()

      if (statsData.success) {
        setStats(statsData)
      }
      if (priceDataResult.success) {
        setPriceData(priceDataResult.data)
      }
    } catch (error) {
      console.error('Failed to load LP price data:', error)
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
      const response = await fetch('/api/bigquery/lp-prices/estimate', {
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
      const response = await fetch('/api/bigquery/lp-prices/simulate', {
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
      const response = await fetch('/api/bigquery/lp-prices/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      })
      const data = await response.json()
      setBackfillResult(data)

      // Reload data if successful
      if (data.success && (data.rows_inserted > 0 || data.rows_updated > 0)) {
        await loadData()
      }
    } catch (error) {
      setBackfillResult({ success: false, rows_fetched: 0, rows_inserted: 0, rows_updated: 0, rows_skipped: 0, estimated_cost: '0', error: (error as Error).message })
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

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file && (file.type === 'application/json' || file.name.endsWith('.json') || file.name.endsWith('.ndjson'))) {
      setJsonFile(file)
      setUploadResult(null)
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    const file = e.dataTransfer.files?.[0]
    if (file && (file.type === 'application/json' || file.name.endsWith('.json') || file.name.endsWith('.ndjson'))) {
      setJsonFile(file)
      setUploadResult(null)
    }
  }

  async function uploadJson() {
    if (!jsonFile) return

    setUploading(true)
    setUploadResult(null)
    try {
      const formData = new FormData()
      formData.append('file', jsonFile)
      formData.append('dryRun', String(previewMode))

      const response = await fetch('/api/bigquery/lp-prices/upload', {
        method: 'POST',
        body: formData,
      })
      const data: UploadResult = await response.json()
      setUploadResult(data)

      // Reload data if successful and not preview mode
      if (data.success && !previewMode && data.rows_inserted > 0) {
        await loadData()
      }
    } catch (error) {
      setUploadResult({
        success: false,
        rows_processed: 0,
        rows_inserted: 0,
        rows_skipped: 0,
        dry_run: previewMode,
        error: (error as Error).message,
      })
    } finally {
      setUploading(false)
    }
  }

  function reset() {
    setEstimateResult(null)
    setSimulateResult(null)
    setBackfillResult(null)
    setJsonFile(null)
    setUploadResult(null)
    setPreviewMode(true)
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
          <TrendingUp className="h-6 w-6" />
          LP Token Price Backfill
        </CardTitle>
        <CardDescription>
          Import historical BLND/USDC LP token prices from Hubble BigQuery
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 p-4 bg-muted/50 rounded-lg">
          <div>
            <p className="text-xs text-muted-foreground mb-1">LP Token</p>
            <p className="font-mono text-xs">{truncateAddress(stats?.lp_token_address)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">Total Price Days</p>
            <p className="text-lg font-bold">{stats?.totalPrices || 0}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">Date Range</p>
            <p className="text-sm">
              {stats?.earliestDate && stats?.latestDate
                ? `${stats.earliestDate} → ${stats.latestDate}`
                : 'No data yet'}
            </p>
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
            variant={mode === 'upload' ? 'default' : 'outline'}
            onClick={() => setMode('upload')}
            className="flex-1"
          >
            <Upload className="mr-2 h-4 w-4" />
            Upload JSON
          </Button>
        </div>

        {/* Query Mode */}
        {mode === 'query' && (
          <>
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
                            <TableHead className="text-right">Price (USD)</TableHead>
                            <TableHead className="text-right">Ledger</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {simulateResult.rows.map((row, i) => (
                            <TableRow key={i}>
                              <TableCell className="font-mono text-xs">
                                {row.price_date}
                              </TableCell>
                              <TableCell className="text-right font-mono">
                                ${row.lp_token_price.toFixed(6)}
                              </TableCell>
                              <TableCell className="text-right font-mono text-xs">
                                {row.ledger_sequence || '-'}
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
                    <p>Rows skipped: <strong>{backfillResult.rows_skipped.toLocaleString()}</strong></p>
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
          </>
        )}

        {/* Upload Mode */}
        {mode === 'upload' && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Run the BigQuery query manually and export results as JSON, then upload here.
            </p>

            {/* Preview Mode Toggle */}
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="previewMode"
                checked={previewMode}
                onChange={(e) => setPreviewMode(e.target.checked)}
                className="rounded border-gray-600"
              />
              <label htmlFor="previewMode" className="text-sm text-muted-foreground">
                Preview mode (validate file without saving to database)
              </label>
            </div>

            {/* Drop Zone */}
            <div
              className={`relative border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                jsonFile ? 'border-green-500 bg-green-500/10' : 'border-muted-foreground/25 hover:border-muted-foreground/50'
              }`}
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
            >
              {jsonFile ? (
                <div className="space-y-2">
                  <FileText className="mx-auto h-8 w-8 text-green-500" />
                  <p className="text-sm font-medium">{jsonFile.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {(jsonFile.size / 1024).toFixed(1)} KB
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setJsonFile(null)}
                  >
                    Remove
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <Upload className="mx-auto h-8 w-8 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    Drop JSON file here or click to browse
                  </p>
                  <input
                    type="file"
                    accept=".json,.ndjson,.jsonl"
                    onChange={handleFileChange}
                    className="absolute inset-0 opacity-0 cursor-pointer"
                  />
                </div>
              )}
            </div>

            {/* Upload Button */}
            <Button
              onClick={uploadJson}
              disabled={!jsonFile || uploading}
              className="w-full"
            >
              {uploading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {previewMode ? 'Validating...' : 'Importing...'}
                </>
              ) : (
                <>
                  <Upload className="mr-2 h-4 w-4" />
                  {previewMode ? 'Preview Import' : 'Import LP Prices'}
                </>
              )}
            </Button>

            {/* Upload Result */}
            {uploadResult && uploadResult.success && (
              <Alert variant={uploadResult.dry_run ? 'info' : 'success'}>
                {uploadResult.dry_run ? (
                  <Info className="h-4 w-4" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                <AlertTitle>
                  {uploadResult.dry_run ? 'Preview Complete' : 'Import Successful'}
                </AlertTitle>
                <AlertDescription>
                  <div className="space-y-1 mt-2">
                    <p>Rows in file: <strong>{uploadResult.rows_processed}</strong></p>
                    <p>New rows to insert: <strong>{uploadResult.rows_inserted}</strong></p>
                    <p>Already exists (skipped): <strong>{uploadResult.rows_skipped}</strong></p>
                  </div>
                  {uploadResult.dry_run && uploadResult.rows_inserted > 0 && (
                    <div className="mt-4">
                      <Button
                        variant="default"
                        onClick={() => {
                          setPreviewMode(false)
                          uploadJson()
                        }}
                      >
                        Confirm Import
                      </Button>
                    </div>
                  )}
                  {!uploadResult.dry_run && (
                    <Button variant="secondary" className="mt-4" onClick={reset}>
                      Upload Another
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            )}

            {uploadResult && !uploadResult.success && (
              <Alert variant="destructive">
                <XCircle className="h-4 w-4" />
                <AlertTitle>Import Failed</AlertTitle>
                <AlertDescription>
                  <p>{uploadResult.error || 'Unknown error'}</p>
                  <Button variant="secondary" className="mt-4" onClick={reset}>
                    Try Again
                  </Button>
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}

        {/* Recent Data Preview */}
        {priceData.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4" />
              <p className="text-sm font-medium">Recent LP Prices</p>
            </div>
            <div className="max-h-64 overflow-auto rounded-lg border bg-background">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Price (USD)</TableHead>
                    <TableHead>Source</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {priceData.map((row, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono text-xs">
                        {row.price_date}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        ${row.lp_token_price.toFixed(6)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {row.source}
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
