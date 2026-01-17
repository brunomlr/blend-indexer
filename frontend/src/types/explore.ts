// User Action Types
export type ActionType =
  | 'supply'
  | 'withdraw'
  | 'supply_collateral'
  | 'withdraw_collateral'
  | 'borrow'
  | 'repay'
  | 'claim'
  | 'liquidate'
  | 'new_auction'
  | 'fill_auction'
  | 'delete_auction'

// Pool Metadata
export interface Pool {
  pool_id: string
  name: string
  short_name: string | null
  description: string | null
  icon_url: string | null
  website_url: string | null
  is_active: boolean
  version: number
}

// Token Metadata
export interface Token {
  asset_address: string
  symbol: string
  name: string | null
  decimals: number
  icon_url: string | null
  coingecko_id: string | null
  is_native: boolean
}

// Query types for the explore page
export type ExploreQueryType = 'deposits' | 'events' | 'balance' | 'top-depositors' | 'aggregates' | 'pools'

// Time range presets
export type TimeRangePreset = '7d' | '30d' | '90d' | '1y' | 'all'

// Result types for different queries
export interface AccountDepositResult {
  userAddress: string
  totalDeposited: number
  totalDepositedUsd: number
  depositCount: number
  lastDepositDate: string
  assetSymbol?: string
}

export interface AccountEventCountResult {
  userAddress: string
  eventCount: number
  eventsByType: Record<string, number>
  firstEventDate: string
  lastEventDate: string
}

export interface AccountBalanceResult {
  userAddress: string
  balance: number
  balanceUsd: number
  supplyBalance: number
  collateralBalance: number
  debtBalance: number
  netBalance: number
  assetSymbol?: string
}

export interface TopDepositorResult {
  userAddress: string
  poolId: string
  poolName: string
  totalDeposited: number
  totalDepositedUsd: number
  rank: number
  assetSymbol?: string
}

export interface AggregateMetrics {
  totalDeposits: number
  totalDepositsUsd: number
  totalWithdrawals: number
  totalWithdrawalsUsd: number
  netFlow: number
  netFlowUsd: number
  activeAccounts: number
  totalEvents: number
}

export interface TokenVolumeResult {
  assetAddress: string
  symbol: string
  name: string | null
  depositVolume: number
  depositVolumeUsd: number
  withdrawVolume: number
  withdrawVolumeUsd: number
  netVolume: number
  netVolumeUsd: number
}

export interface PoolStatisticsResult {
  poolId: string
  poolName: string
  poolShortName: string | null
  eventCount: number
  uniqueEventTypes: string[]
  uniqueEventTypeCount: number
  firstEventDate: string | null
  lastEventDate: string | null
}

// Filter parameters for explore queries
export interface ExploreFilters {
  query: ExploreQueryType
  assetAddress?: string
  poolId?: string
  minAmount?: number
  minCount?: number
  inUsd: boolean
  eventTypes?: ActionType[]
  startDate?: string
  endDate?: string
  orderBy?: 'amount' | 'count' | 'date'
  orderDir?: 'asc' | 'desc'
  limit: number
  offset: number
  hasBorrows?: boolean
  hasDeposits?: boolean
}

// API response types
export interface ExploreDepositsResponse {
  query: 'deposits'
  filters: ExploreFilters
  count: number
  totalCount: number
  results: AccountDepositResult[]
  aggregates: AggregateMetrics
}

export interface ExploreEventsResponse {
  query: 'events'
  filters: ExploreFilters
  count: number
  totalCount: number
  results: AccountEventCountResult[]
  aggregates: AggregateMetrics
}

export interface ExploreBalanceResponse {
  query: 'balance'
  filters: ExploreFilters
  count: number
  totalCount: number
  results: AccountBalanceResult[]
  aggregates: AggregateMetrics
}

export interface ExploreTopDepositorsResponse {
  query: 'top-depositors'
  filters: ExploreFilters
  count: number
  results: TopDepositorResult[]
  aggregates: AggregateMetrics
}

export interface ExploreAggregatesResponse {
  query: 'aggregates'
  filters: ExploreFilters
  aggregates: AggregateMetrics
  volumeByToken: TokenVolumeResult[]
}

export interface ExplorePoolsResponse {
  query: 'pools'
  filters: ExploreFilters
  count: number
  totalCount: number
  results: PoolStatisticsResult[]
  aggregates: AggregateMetrics
}

export type ExploreResponse =
  | ExploreDepositsResponse
  | ExploreEventsResponse
  | ExploreBalanceResponse
  | ExploreTopDepositorsResponse
  | ExploreAggregatesResponse
  | ExplorePoolsResponse
