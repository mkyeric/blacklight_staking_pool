"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";

/**
 * Returns the latest block's timestamp from the connected chain.
 * Uses the chain's notion of time (block.timestamp) instead of system clock,
 * so countdowns match what the contract will enforce. Falls back to Date.now()
 * when not connected to a chain.
 *
 * Refetches every 4 seconds to stay in sync with new blocks.
 */
export function useBlockTimestamp(): number {
  const publicClient = usePublicClient();

  const { data: blockTimestamp } = useQuery({
    queryKey: ["blockTimestamp"],
    queryFn: async () => {
      if (!publicClient) return undefined;
      const block = await publicClient.getBlock({ blockTag: "latest" });
      return Number(block.timestamp ?? 0);
    },
    enabled: !!publicClient,
    refetchInterval: 4000, // ~block time on most chains
  });

  // Fallback to system clock when disconnected (preserves behavior when no chain)
  if (blockTimestamp !== undefined) return blockTimestamp;
  return Math.floor(Date.now() / 1000);
}
