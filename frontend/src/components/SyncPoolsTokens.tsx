import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Loader2, CheckCircle2, XCircle, AlertTriangle, RefreshCw } from 'lucide-react'

interface Stats {
  trackedPoolsCount: number
  poolsCount: number
  tokensCount: number
}

interface SyncResult {
  success: boolean
  pools_synced: number
  tokens_inserted: number
  tokens_updated: number
  pools_errors?: string[]
  tokens_errors?: string[]
  error?: string
}

export function SyncPoolsTokens() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [result, setResult] = useState<SyncResult | null>(null)

  useEffect(() => {
    loadStats()
  }, [])

  async function loadStats() {
    try {
      const response = await fetch('/api/bigquery/sync/stats')
      const data = await response.json()
      if (data.success) {
        setStats(data)
      }
    } catch (error) {
      console.error('Failed to load stats:', error)
    }
  }

  async function runSync() {
    setSyncing(true)
    setResult(null)
    try {
      const response = await fetch('/api/bigquery/sync/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const data = await response.json()
      setResult(data)
      if (data.success) {
        loadStats()
      }
    } catch (error) {
      setResult({ success: false, pools_synced: 0, tokens_inserted: 0, tokens_updated: 0, error: (error as Error).message })
    } finally {
      setSyncing(false)
    }
  }

  return (
    <Card className="border-border/50">
      <CardHeader>
        <CardTitle className="text-2xl">Sync Pools & Tokens</CardTitle>
        <CardDescription>
          Update reference tables from TRACKED_POOLS config and discovered tokens
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 p-4 bg-muted/50 rounded-lg">
          <div className="text-center">
            <p className="text-xs text-muted-foreground mb-1">Tracked Pools (Config)</p>
            <p className="text-2xl font-bold">{stats?.trackedPoolsCount ?? '-'}</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-muted-foreground mb-1">Pools in DB</p>
            <p className="text-2xl font-bold">{stats?.poolsCount ?? '-'}</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-muted-foreground mb-1">Tokens in DB</p>
            <p className="text-2xl font-bold">{stats?.tokensCount ?? '-'}</p>
          </div>
        </div>

        {/* Help Text */}
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>When to use</AlertTitle>
          <AlertDescription>
            <p className="mb-2">Run this after backfilling data to ensure the pools and tokens reference tables are up to date. This syncs:</p>
            <ul className="list-disc list-inside space-y-1 text-sm">
              <li><strong>Pools:</strong> from TRACKED_POOLS configuration</li>
              <li><strong>Tokens:</strong> discovered from events tables + Blend SDK metadata</li>
            </ul>
          </AlertDescription>
        </Alert>

        {/* Sync Button */}
        <Button
          className="w-full"
          onClick={runSync}
          disabled={syncing}
        >
          {syncing ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Syncing...
            </>
          ) : (
            <>
              <RefreshCw className="mr-2 h-4 w-4" />
              Sync Pools & Tokens
            </>
          )}
        </Button>

        {/* Result */}
        {result && result.success && (
          <Alert variant="success">
            <CheckCircle2 className="h-4 w-4" />
            <AlertTitle>Sync Successful</AlertTitle>
            <AlertDescription>
              <div className="space-y-1 mt-2">
                <p>Pools synced: <strong>{result.pools_synced}</strong></p>
                <p>Tokens inserted: <strong>{result.tokens_inserted}</strong></p>
                <p>Tokens updated: <strong>{result.tokens_updated}</strong></p>
              </div>
              {result.pools_errors && result.pools_errors.length > 0 && (
                <p className="text-destructive mt-2">Pool errors: {result.pools_errors.join(', ')}</p>
              )}
              {result.tokens_errors && result.tokens_errors.length > 0 && (
                <p className="text-destructive mt-2">Token errors: {result.tokens_errors.length} errors</p>
              )}
              <Button variant="secondary" className="mt-4" onClick={runSync}>
                Run Again
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {result && !result.success && (
          <Alert variant="destructive">
            <XCircle className="h-4 w-4" />
            <AlertTitle>Sync Failed</AlertTitle>
            <AlertDescription>
              <p>{result.error || 'Unknown error'}</p>
              <Button variant="secondary" className="mt-4" onClick={runSync}>
                Try Again
              </Button>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}
