"use client";

import { useMemo } from "react";
import { useAccount } from "wagmi";
import { useFactoryPools } from "@/hooks/useFactoryPools";

/**
 * Returns true if the connected wallet matches the operator address of any pool
 * created by the factory. Operator wallets are reserved for running the Blacklight
 * node and must not be used for staking.
 */
export function useIsOperatorWallet(): boolean {
  const { address } = useAccount();
  const { pools } = useFactoryPools();

  return useMemo(() => {
    if (!address) return false;
    const lower = address.toLowerCase();
    return pools.some((p) => p.operator.toLowerCase() === lower);
  }, [address, pools]);
}
