import { useQuery } from "@tanstack/react-query"
import type { Pool, Token } from "@/types/explore"

export interface MetadataResponse {
  pools?: Pool[]
  tokens?: Token[]
}

/**
 * Hook to fetch pool and token metadata from the database
 */
export function useMetadata(enabled = true) {
  const query = useQuery({
    queryKey: ["metadata"],
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/metadata", { signal })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.message || "Failed to fetch metadata")
      }

      return response.json() as Promise<MetadataResponse>
    },
    enabled,
    staleTime: 60 * 60 * 1000, // 1 hour
    refetchOnWindowFocus: false,
    retry: 2,
  })

  return {
    isLoading: query.isLoading,
    error: query.error as Error | null,
    pools: query.data?.pools || [],
    tokens: query.data?.tokens || [],
    refetch: query.refetch,
  }
}
