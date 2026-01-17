import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Loader2, ExternalLink, Download } from 'lucide-react'
import { TokenStatistics } from './TokenStatistics'

interface Token {
  asset_address: string
  symbol: string
  name: string | null
  decimals: number
  coingecko_id: string | null
  pegged_currency: string | null
  is_native: boolean
}

interface TokensResponse {
  success: boolean
  count: number
  tokens: Token[]
  error?: string
}

interface BackfillResult {
  symbol: string
  coingeckoId: string
  inserted: number
  error?: string
}

interface BackfillResponse {
  success: boolean
  dateRange: { startDate: string; endDate: string }
  tokens: BackfillResult[]
  peggedTokensInserted: number
  totalInserted: number
  error?: string
}

export function TokensList() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tokens, setTokens] = useState<Token[]>([])

  // Backfill state
  const [startDate, setStartDate] = useState('2025-04-15')
  const [endDate, setEndDate] = useState(new Date().toISOString().split('T')[0])
  const [selectedToken, setSelectedToken] = useState<string>('all')
  const [backfillLoading, setBackfillLoading] = useState(false)
  const [backfillResult, setBackfillResult] = useState<BackfillResponse | null>(null)

  useEffect(() => {
    loadTokens()
  }, [])

  async function loadTokens() {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/tokens')
      const data: TokensResponse = await response.json()
      if (data.success) {
        setTokens(data.tokens)
      } else {
        setError(data.error || 'Failed to load tokens')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  async function runBackfill() {
    setBackfillLoading(true)
    setBackfillResult(null)
    setError(null)
    try {
      const body: { startDate: string; endDate: string; tokenAddress?: string } = { startDate, endDate }
      if (selectedToken !== 'all') {
        body.tokenAddress = selectedToken
      }
      const response = await fetch('/api/tokens/backfill-prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data: BackfillResponse = await response.json()
      setBackfillResult(data)
      if (!data.success) {
        setError(data.error || 'Backfill failed')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBackfillLoading(false)
    }
  }

  function getCoinGeckoUrl(coingeckoId: string): string {
    return `https://www.coingecko.com/en/coins/${coingeckoId}`
  }

  function truncateAddress(address: string): string {
    return `${address.slice(0, 8)}...${address.slice(-6)}`
  }

  const coingeckoTokens = tokens.filter(t => t.coingecko_id && !t.pegged_currency)
  const peggedTokens = tokens.filter(t => t.pegged_currency)
  const backfillableTokens = [...coingeckoTokens, ...peggedTokens]

  // Debug: log token counts
  console.log('[TokensList] Total tokens:', tokens.length, 'CoinGecko:', coingeckoTokens.length, 'Pegged:', peggedTokens.length)
  console.log('[TokensList] Pegged tokens:', peggedTokens.map(t => `${t.symbol}(${t.pegged_currency})`))

  return (
    <div className="space-y-6">
    <Card className="border-border/50">
      <CardHeader>
        <CardTitle className="text-2xl">Tokens</CardTitle>
        <CardDescription>
          All tokens tracked in the database with CoinGecko mappings
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <span className="ml-2 text-muted-foreground">Loading tokens...</span>
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!loading && !error && (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Symbol</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>CoinGecko</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map((token) => (
                  <TableRow key={token.asset_address}>
                    <TableCell className="font-medium">{token.symbol}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {token.name || '-'}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {truncateAddress(token.asset_address)}
                    </TableCell>
                    <TableCell>
                      {token.is_native && (
                        <Badge variant="secondary">Native</Badge>
                      )}
                      {token.pegged_currency && (
                        <Badge variant="outline">{token.pegged_currency} Pegged</Badge>
                      )}
                      {!token.is_native && !token.pegged_currency && (
                        <Badge variant="default">Token</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {token.coingecko_id ? (
                        <a
                          href={getCoinGeckoUrl(token.coingecko_id)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-sm text-blue-400 hover:text-blue-300 hover:underline"
                        >
                          {token.coingecko_id}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span className="text-muted-foreground text-sm">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {!loading && !error && tokens.length === 0 && (
          <div className="text-center py-8 text-muted-foreground">
            No tokens found
          </div>
        )}

        {!loading && !error && tokens.length > 0 && (
          <p className="mt-4 text-sm text-muted-foreground">
            {tokens.length} tokens total
          </p>
        )}

        {/* CoinGecko Price Backfill Section */}
        {!loading && backfillableTokens.length > 0 && (
          <div className="mt-6 pt-6 border-t border-border/50">
            <h3 className="text-lg font-semibold mb-4">Historical Price Backfill</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Fetch historical prices from CoinGecko for tokens ({coingeckoTokens.map(t => t.symbol).join(', ')})
              and forex rates for pegged tokens ({peggedTokens.map(t => t.symbol).join(', ')})
            </p>

            <div className="flex flex-wrap items-end gap-4 mb-4">
              <div className="grid gap-2">
                <Label htmlFor="tokenSelect">Token</Label>
                <NativeSelect
                  id="tokenSelect"
                  value={selectedToken}
                  onChange={(e) => setSelectedToken(e.target.value)}
                  className="w-56"
                >
                  <option value="all">All tokens ({backfillableTokens.length})</option>
                  {coingeckoTokens.length > 0 && (
                    <optgroup label="CoinGecko Tokens">
                      {coingeckoTokens.map((t) => (
                        <option key={t.asset_address} value={t.asset_address}>
                          {t.symbol} ({t.coingecko_id})
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {peggedTokens.length > 0 && (
                    <optgroup label="Pegged Tokens (Forex)">
                      {peggedTokens.map((t) => (
                        <option key={t.asset_address} value={t.asset_address}>
                          {t.symbol} ({t.pegged_currency} pegged)
                        </option>
                      ))}
                    </optgroup>
                  )}
                </NativeSelect>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="startDate">Start Date</Label>
                <Input
                  id="startDate"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-40"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="endDate">End Date</Label>
                <Input
                  id="endDate"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="w-40"
                />
              </div>
              <Button onClick={runBackfill} disabled={backfillLoading}>
                {backfillLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Fetching...
                  </>
                ) : (
                  <>
                    <Download className="mr-2 h-4 w-4" />
                    Run Backfill
                  </>
                )}
              </Button>
            </div>

            {backfillLoading && (
              <Alert>
                <AlertDescription>
                  Fetching prices from CoinGecko... This may take a while due to rate limiting (~2.5s per token).
                </AlertDescription>
              </Alert>
            )}

            {backfillResult && backfillResult.success && (
              <div className="space-y-2">
                <Alert>
                  <AlertDescription>
                    <span className="font-semibold">Backfill complete!</span> Inserted {backfillResult.totalInserted} price points.
                  </AlertDescription>
                </Alert>
                <div className="text-sm space-y-1 mt-2">
                  {backfillResult.tokens.map((t) => (
                    <div key={t.coingeckoId} className="flex items-center gap-2">
                      <span className="font-medium">{t.symbol}:</span>
                      {t.error ? (
                        <span className="text-red-400">{t.error}</span>
                      ) : (
                        <span className="text-green-400">{t.inserted} prices inserted</span>
                      )}
                    </div>
                  ))}
                  {backfillResult.peggedTokensInserted > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="font-medium">Pegged tokens:</span>
                      <span className="text-green-400">{backfillResult.peggedTokensInserted} prices inserted</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>

    <TokenStatistics />
    </div>
  )
}
