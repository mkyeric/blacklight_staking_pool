"use client";

import { useMemo } from "react";
import { useAccount } from "wagmi";
import { useReadContracts } from "wagmi";
import { POOL_PHASE, blacklightPoolAbi } from "@/lib/contracts";
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
      pools.flatMap((p) => [
        {
          address: p.pool,
          abi: blacklightPoolAbi,
          functionName: "platformFeeRecipient" as const,
        },
        {
          address: p.pool,
          abi: blacklightPoolAbi,
          functionName: "poolPhase" as const,
        },
        {
          address: p.pool,
          abi: blacklightPoolAbi,
          functionName: "totalUserStakes" as const,
        },
        {
          address: p.pool,
          abi: blacklightPoolAbi,
          functionName: "totalProcessingStake" as const,
        },
      ]),
    [pools]
  );

  const { data: results, isLoading: recipientsLoading } = useReadContracts({
    contracts,
    query: { enabled: isConnected && !!address && pools.length > 0 },
  });

  const keeperPools = useMemo(() => {
    if (!isConnected || !address || !results || results.length !== pools.length * 4)
      return [];
    const addrLower = address.toLowerCase();
    return pools.filter((pool, i) => {
      const recipientResult = results[i * 4];
      const phaseResult = results[i * 4 + 1];
      const totalUserStakesResult = results[i * 4 + 2];
      const totalProcessingStakeResult = results[i * 4 + 3];

      if (!recipientResult?.result) return false;
      const recipient = (recipientResult.result as string)?.toLowerCase?.() ?? "";
      if (recipient !== addrLower) return false;

      const phase = Number(phaseResult?.result ?? -1);
      const totalUserStakes = (totalUserStakesResult?.result as bigint | undefined) ?? 0n;
      const totalProcessingStake =
        (totalProcessingStakeResult?.result as bigint | undefined) ?? 0n;

      // Remove fully exited pools from Keeper tab once shut down.
      const isShutDownAndEmpty =
        phase === POOL_PHASE.ShuttingDown &&
        totalUserStakes === 0n &&
        totalProcessingStake === 0n;

      return !isShutDownAndEmpty;
    });
  }, [pools, results, address, isConnected]);

  const isLoading = poolsLoading || recipientsLoading;
  const isKeeper = isConnected && !!address && keeperPools.length > 0;

  return { keeperPools, isLoading, isKeeper };
}
