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
    async function load() {
      if (!publicClient || !POOL_FACTORY_ADDRESS) return;
      setIsLoading(true);
      setError(undefined);
      try {
        const event = poolFactoryAbi[0];
        const logs = await publicClient.getLogs({
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

        setPools(Array.from(uniqueByPool.values()));
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

