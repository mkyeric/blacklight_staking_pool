"use client";

import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import {
  POOL_FACTORY_ADDRESS,
  poolFactoryAbi,
} from "@/lib/contracts";

export type FactoryPool = {
  owner: `0x${string}`;
  operator: `0x${string}`;
  pool: `0x${string}`;
};

type UseFactoryPoolsResult = {
  pools: FactoryPool[];
  isLoading: boolean;
  error?: Error;
};

/**
 * Fetches pools created by the PoolFactory by reading historical PoolCreated logs.
 * This is enough for e2e testing and local deployments.
 */
export function useFactoryPools(): UseFactoryPoolsResult {
  const publicClient = usePublicClient();
  const [pools, setPools] = useState<FactoryPool[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>();

  useEffect(() => {
    if (!publicClient || !POOL_FACTORY_ADDRESS) {
      // Wagmi may not have publicClient on first paint; treat as loading so we
      // don't show "No pools" until we've actually attempted a fetch.
      if (!publicClient) setIsLoading(true);
      return;
    }

    const client = publicClient;

    async function load() {
      setIsLoading(true);
      setError(undefined);
      try {
        const event = poolFactoryAbi[0];
        const logs = await client.getLogs({
          address: POOL_FACTORY_ADDRESS,
          event,
          fromBlock: 0n,
          toBlock: "latest",
        });

        const created: FactoryPool[] = logs.map((log) => ({
          owner: log.args.owner as `0x${string}`,
          operator: log.args.operator as `0x${string}`,
          pool: log.args.pool as `0x${string}`,
        }));

        // Deduplicate by pool address in case of any reorgs or repeats.
        const uniqueByPool = new Map<string, FactoryPool>();
        for (const p of created) {
          uniqueByPool.set(p.pool.toLowerCase(), p);
        }

        const uniquePools = Array.from(uniqueByPool.values());
        setPools(uniquePools);
      } catch (e) {
        setError(e as Error);
      } finally {
        setIsLoading(false);
      }
    }

    load();
  }, [publicClient]);

  return { pools, isLoading, error };
}

