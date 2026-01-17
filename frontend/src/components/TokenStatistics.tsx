import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2 } from 'lucide-react'

interface TokenStatistic {
  asset_address: string
  symbol: string
  name: string | null
  total_records: number
  source_counts: Record<string, number>
  earliest_date: string | null
  latest_date: string | null
  earliest_price: number | null
  latest_price: number | null
}

interface StatisticsResponse {
  success: boolean
  sources: string[]
  statistics: TokenStatistic[]
  count: number
  error?: string
}

export function TokenStatistics() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sources, setSources] = useState<string[]>([])
  const [statistics, setStatistics] = useState<TokenStatistic[]>([])

  useEffect(() => {
    loadStatistics()
  }, [])

  async function loadStatistics() {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/token-statistics')
      const data: StatisticsResponse = await response.json()
      if (data.success) {
        setSources(data.sources)
        setStatistics(data.statistics)
      } else {
        setError(data.error || 'Failed to load statistics')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  function formatDate(dateStr: string | null): string {
    if (!dateStr) return '-'
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  function formatPrice(price: number | null): string {
    if (price === null || price === undefined) return '-'
    if (price < 0.01) return `$${price.toFixed(6)}`
    if (price < 1) return `$${price.toFixed(4)}`
    return `$${price.toFixed(2)}`
  }

  return (
    <Card className="border-border/50">
      <CardHeader>
        <CardTitle className="text-2xl">Token Price Statistics</CardTitle>
        <CardDescription>
          Overview of daily price records per token from all sources
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <span className="ml-2 text-muted-foreground">Loading statistics...</span>
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!loading && !error && (
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 bg-background">Token</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  {sources.map(source => (
                    <TableHead key={source} className="text-right">{source}</TableHead>
                  ))}
                  <TableHead>Earliest</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead>Latest</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {statistics.map((stat) => (
                  <TableRow key={stat.asset_address}>
                    <TableCell className="sticky left-0 bg-background font-medium">
                      {stat.symbol}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {stat.total_records.toLocaleString()}
                    </TableCell>
                    {sources.map(source => (
                      <TableCell key={source} className="text-right font-mono text-muted-foreground">
                        {stat.source_counts[source] || 0}
                      </TableCell>
                    ))}
                    <TableCell className="text-muted-foreground text-sm">
                      {formatDate(stat.earliest_date)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-muted-foreground">
                      {formatPrice(stat.earliest_price)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatDate(stat.latest_date)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-muted-foreground">
                      {formatPrice(stat.latest_price)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {!loading && !error && statistics.length === 0 && (
          <div className="text-center py-8 text-muted-foreground">
            No token statistics found
          </div>
        )}

        {!loading && !error && statistics.length > 0 && (
          <p className="mt-4 text-sm text-muted-foreground">
            {statistics.length} tokens, {statistics.reduce((sum, s) => sum + s.total_records, 0).toLocaleString()} total price records
          </p>
        )}
      </CardContent>
    </Card>
  )
}
