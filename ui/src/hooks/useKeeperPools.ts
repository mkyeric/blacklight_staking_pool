"use client";

import { useMemo } from "react";
import { useAccount } from "wagmi";
import { useReadContracts } from "wagmi";
import { blacklightPoolAbi } from "@/lib/contracts";
import { useFactoryPools } from "@/hooks/useFactoryPools";
import type { FactoryPool } from "@/hooks/useFactoryPools";

type UseKeeperPoolsResult = {
  keeperPools: FactoryPool[];
  isLoading: boolean;
  isKeeper: boolean;
};

/**
 * Returns pools where the connected wallet is the platform fee recipient.
 * The Keeper tab should only be visible when isKeeper is true.
 */
export function useKeeperPools(): UseKeeperPoolsResult {
  const { address, isConnected } = useAccount();
  const { pools, isLoading: poolsLoading } = useFactoryPools();

  const contracts = useMemo(
    () =>
      pools.map((p) => ({
        address: p.pool,
        abi: blacklightPoolAbi,
        functionName: "platformFeeRecipient" as const,
      })),
    [pools]
  );

  const { data: results, isLoading: recipientsLoading } = useReadContracts({
    contracts,
    query: { enabled: isConnected && !!address && pools.length > 0 },
  });

  const keeperPools = useMemo(() => {
    if (!isConnected || !address || !results || results.length !== pools.length)
      return [];
    const addrLower = address.toLowerCase();
    return pools.filter((pool, i) => {
      const r = results[i];
      if (!r?.result) return false;
      const recipient = (r.result as string)?.toLowerCase?.() ?? "";
      return recipient === addrLower;
    });
  }, [pools, results, address, isConnected]);

  const isLoading = poolsLoading || recipientsLoading;
  const isKeeper = isConnected && !!address && keeperPools.length > 0;

  return { keeperPools, isLoading, isKeeper };
}
