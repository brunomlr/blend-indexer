import { useState, useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { useMetadata } from "@/hooks/use-metadata"
import { NativeSelect } from "@/components/ui/native-select"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { Radio, ExternalLink } from "lucide-react"

interface BlendAction {
  id: string
  pool_id: string
  transaction_hash: string
  ledger_sequence: number
  ledger_closed_at: string
  action_type: string
  asset_address: string | null
  user_address: string | null
  amount_underlying: string | null
  amount_tokens: string | null
  src: string
}

interface BackstopEvent {
  id: string
  transaction_hash: string
  ledger_sequence: number
  ledger_closed_at: string
  action_type: string
  pool_address: string | null
  user_address: string | null
  lp_tokens: string | null
  shares: string | null
  src: string
}

interface LiveResponse {
  actions: BlendAction[]
  backstop: BackstopEvent[]
}

interface UnifiedRow {
  id: string
  time: string
  actionType: string
  source: "pool" | "backstop"
  userAddress: string | null
  amount: string | null
  assetAddress: string | null
  txHash: string
  ledgerSequence: number
}

const ACTION_TYPE_VARIANTS: Record<string, string> = {
  supply: "supply",
  withdraw: "withdraw",
  supply_collateral: "supply_collateral",
  withdraw_collateral: "withdraw_collateral",
  borrow: "borrow",
  repay: "repay",
  claim: "claim",
  deposit: "deposit",
  queue_withdrawal: "queue_withdrawal",
  dequeue_withdrawal: "dequeue_withdrawal",
  donate: "donate",
  draw: "draw",
  gulp_emissions: "gulp_emissions",
}

function truncateAddress(addr: string | null): string {
  if (!addr) return "—"
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function formatAmount(amount: string | null): string {
  if (!amount) return "—"
  const num = parseFloat(amount)
  if (isNaN(num)) return amount
  if (num === 0) return "0"
  // All Stellar amounts are stored as stroops (7 decimals)
  const normalized = num / 1e7
  if (Math.abs(normalized) < 0.001) return normalized.toExponential(2)
  return normalized.toLocaleString(undefined, { maximumFractionDigits: 4 })
}

function formatTime(iso: string): string {
  // Ensure UTC interpretation if the timestamp lacks a timezone suffix
  const raw = iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z"
  const d = new Date(raw)
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

export function LiveTransactions() {
  const { pools, tokens, isLoading: isMetadataLoading } = useMetadata()
  const [selectedPool, setSelectedPool] = useState<string>("")
  const [includeActions, setIncludeActions] = useState(true)
  const [includeBackstop, setIncludeBackstop] = useState(true)

  const tokenMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const t of tokens) {
      map.set(t.asset_address, t.symbol)
    }
    return map
  }, [tokens])

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["live-transactions", selectedPool, includeActions, includeBackstop],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({
        poolId: selectedPool,
        includeActions: String(includeActions),
        includeBackstop: String(includeBackstop),
        limit: "50",
      })
      const res = await fetch(`/api/live/transactions?${params}`, { signal })
      if (!res.ok) throw new Error("Failed to fetch live transactions")
      return res.json() as Promise<LiveResponse>
    },
    enabled: !!selectedPool,
    refetchInterval: 5000,
    refetchOnWindowFocus: false,
  })

  const rows = useMemo<UnifiedRow[]>(() => {
    if (!data) return []

    const actionRows: UnifiedRow[] = (data.actions || []).map((a) => ({
      id: a.id,
      time: a.ledger_closed_at,
      actionType: a.action_type,
      source: "pool" as const,
      userAddress: a.user_address,
      amount: a.amount_underlying,
      assetAddress: a.asset_address,
      txHash: a.transaction_hash,
      ledgerSequence: a.ledger_sequence,
    }))

    const backstopRows: UnifiedRow[] = (data.backstop || []).map((b) => ({
      id: b.id,
      time: b.ledger_closed_at,
      actionType: b.action_type,
      source: "backstop" as const,
      userAddress: b.user_address,
      amount: b.lp_tokens,
      assetAddress: null,
      txHash: b.transaction_hash,
      ledgerSequence: b.ledger_sequence,
    }))

    return [...actionRows, ...backstopRows].sort(
      (a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()
    )
  }, [data])

  return (
    <div className="min-h-screen">
      <div className="container max-w-7xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <div className="relative">
            <Radio className="h-6 w-6 text-green-400" />
            {selectedPool && (
              <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-green-400 animate-pulse" />
            )}
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-white">
              Live Transactions
            </h1>
            <p className="text-zinc-400 mt-1">
              Latest pool actions and backstop events, refreshing every 5s
            </p>
          </div>
          {isFetching && selectedPool && (
            <span className="ml-auto text-xs text-zinc-500">refreshing…</span>
          )}
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-4 mb-6">
          <div className="w-72">
            <NativeSelect
              value={selectedPool}
              onChange={(e) => setSelectedPool(e.target.value)}
              disabled={isMetadataLoading}
            >
              <option value="">Select a pool…</option>
              {pools.map((p) => (
                <option key={p.pool_id} value={p.pool_id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          </div>

          <Button
            variant={includeActions ? "default" : "outline"}
            size="sm"
            onClick={() => setIncludeActions((v) => !v)}
          >
            Pool Actions
          </Button>

          <Button
            variant={includeBackstop ? "default" : "outline"}
            size="sm"
            onClick={() => setIncludeBackstop((v) => !v)}
          >
            Backstop Events
          </Button>
        </div>

        {/* Empty state */}
        {!selectedPool && (
          <div className="text-center py-20 text-zinc-500">
            Select a pool to start streaming transactions
          </div>
        )}

        {/* Loading skeleton */}
        {selectedPool && isLoading && (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        )}

        {/* Table */}
        {selectedPool && !isLoading && (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[170px]">Time</TableHead>
                  <TableHead className="w-[90px]">Source</TableHead>
                  <TableHead className="w-[150px]">Type</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="w-[90px]">Asset</TableHead>
                  <TableHead className="w-[120px]">Tx Hash</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-zinc-500 py-12">
                      No transactions found for this pool
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="text-xs text-zinc-400 whitespace-nowrap">
                        {formatTime(row.time)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={
                            row.source === "pool"
                              ? "border-blue-500 text-blue-400"
                              : "border-amber-500 text-amber-400"
                          }
                        >
                          {row.source === "pool" ? "Pool" : "Backstop"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            (ACTION_TYPE_VARIANTS[row.actionType] as any) ||
                            "secondary"
                          }
                        >
                          {row.actionType}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {truncateAddress(row.userAddress)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {formatAmount(row.amount)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {row.assetAddress
                          ? tokenMap.get(row.assetAddress) ||
                            truncateAddress(row.assetAddress)
                          : row.source === "backstop"
                            ? "LP"
                            : "—"}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <a
                          href={`https://stellar.expert/explorer/public/tx/${row.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-zinc-400 hover:text-white transition-colors"
                        >
                          {truncateAddress(row.txHash)}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  )
}
