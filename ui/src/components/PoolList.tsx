"use client";

import { useMemo, useState, useEffect, useRef } from "react";
import { AbiEvent, formatUnits, parseUnits } from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useReadContracts,
} from "wagmi";
import {
  STAKING_OPERATORS_ADDRESS,
  NIL_DECIMALS,
  MIN_NODE_STAKE,
  stakingOperatorsAbi,
  blacklightPoolAbi,
  POOL_PHASE,
  NIL_TOKEN_ADDRESS,
  nilTokenAbi,
} from "@/lib/contracts";
import { parsePoolDisplayName } from "@/lib/poolMetadata";
import { useFactoryPools } from "@/hooks/useFactoryPools";
import type { FactoryPool } from "@/hooks/useFactoryPools";
import { StakeForm } from "@/components/StakeForm";
import { WithdrawForm, UnbondingStakePanel } from "@/components/WithdrawForm";
import { ShutdownOperations } from "@/components/ShutdownOperations";
import { QuickStakeModal } from "@/components/QuickStakeModal";
import { OperatorWalletWarning } from "@/components/OperatorWalletWarning";
import { useIsOperatorWallet } from "@/hooks/useIsOperatorWallet";

// Component to check if a pool is approved for listing (for filtering).
// Pools tab: only Active phase (poolPhase === 2) with valid operator approval.
// My Pools tab: Active or ShuttingDown so users still see pools they have stake or pending withdrawals in.
function PoolApprovalChecker({
  poolAddress,
  operatorAddress,
  onApprovalStatus,
  includeShuttingDown = false,
}: {
  poolAddress: `0x${string}`;
  operatorAddress: `0x${string}`;
  onApprovalStatus: (isApproved: boolean | null) => void;
  /** When true, ShuttingDown pools are considered approved (for My Pools so stakers see them). */
  includeShuttingDown?: boolean;
}) {
  const { data: poolPhase } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "poolPhase",
  });

  const { data: approvedStaker } = useReadContract({
    address: STAKING_OPERATORS_ADDRESS,
    abi: stakingOperatorsAbi,
    functionName: "approvedStaker",
    args: [operatorAddress],
  });

  const { data: isActive } = useReadContract({
    address: STAKING_OPERATORS_ADDRESS,
    abi: stakingOperatorsAbi,
    functionName: "isActiveOperator",
    args: [operatorAddress],
  });

  const { data: nodeStake } = useReadContract({
    address: STAKING_OPERATORS_ADDRESS,
    abi: stakingOperatorsAbi,
    functionName: "stakeOf",
    args: [operatorAddress],
  });

  const { data: shutdownStatus } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "getShutdownStatus",
    args: ["0x0000000000000000000000000000000000000000"],
  });

  const isPoolActive = poolPhase !== undefined && Number(poolPhase) === POOL_PHASE.Active;
  const isPoolShuttingDown = poolPhase !== undefined && Number(poolPhase) === POOL_PHASE.ShuttingDown;

  const shutdownTuple = shutdownStatus as
    | readonly [boolean, bigint, bigint, boolean]
    | undefined;
  const shutdownPending = shutdownTuple?.[0] ?? false;

  const explicitlyApproved =
    approvedStaker !== undefined &&
    (approvedStaker as string).toLowerCase() === poolAddress.toLowerCase();
  const operatorApproved =
    explicitlyApproved ||
    (isActive === true &&
      nodeStake !== undefined &&
      (nodeStake as bigint) > 0n);

  // Don't report approval until we have all contract data that affects it.
  // Otherwise we can report "not approved" while isActive/nodeStake are still
  // loading, then flip to approved later and only show the pool after tab switch.
  const operatorDataReady =
    explicitlyApproved || (isActive !== undefined && nodeStake !== undefined);
  const shutdownDataReady = includeShuttingDown || shutdownStatus !== undefined;
  const isDataLoaded =
    approvedStaker !== undefined &&
    poolPhase !== undefined &&
    operatorDataReady &&
    shutdownDataReady;
  // Public Pools tab should only show operator-approved pools.
  // My Pools should keep showing pools where the user may still have funds,
  // even if operator approval/active status later changes during shutdown.
  const passesOperatorGate = includeShuttingDown ? true : operatorApproved;

  const isPoolApproved =
    passesOperatorGate &&
    (isPoolActive || (includeShuttingDown && isPoolShuttingDown)) &&
    // When shutdown is pending (cooling-off), hide from the public Pools tab
    // but keep visible in My Pools (includeShuttingDown === true).
    !(shutdownPending && !includeShuttingDown);

  useEffect(() => {
    if (!isDataLoaded) {
      onApprovalStatus(null);
    } else {
      onApprovalStatus(isPoolApproved);
    }
  }, [isDataLoaded, isPoolApproved, onApprovalStatus]);

  return null;
}

type PoolListProps = {
  onStakeSuccess?: (poolAddress: string) => void;
};

export function PoolList({ onStakeSuccess }: PoolListProps = {}) {
  const isOperatorWallet = useIsOperatorWallet();
  const { pools, isLoading, error } = useFactoryPools();
  const [poolApprovalStatuses, setPoolApprovalStatuses] = useState<
    Map<string, boolean | null>
  >(new Map());

  const updatePoolApprovalStatus = (poolAddress: string) => {
    return (status: boolean | null) => {
      setPoolApprovalStatuses((prev) => {
        if (prev.get(poolAddress) === status) return prev;
        const next = new Map(prev);
        next.set(poolAddress, status);
        return next;
      });
    };
  };

  // Filter pools to only show approved ones
  const approvedPools = useMemo(() => {
    return pools.filter((pool) => {
      const status = poolApprovalStatuses.get(pool.pool);
      // Only include if approval status is loaded and pool is approved
      return status === true;
    });
  }, [pools, poolApprovalStatuses]);

  // Check if we're still loading approval statuses
  const isCheckingApprovals = useMemo(() => {
    if (pools.length === 0) return false;
    return pools.some(
      (pool) => !poolApprovalStatuses.has(pool.pool) || poolApprovalStatuses.get(pool.pool) === null
    );
  }, [pools, poolApprovalStatuses]);

  if (isLoading) {
    return (
      <section className="card p-6 text-center">
        <p className="text-sm text-blacklight-text-muted">
          Loading pools from factory…
        </p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="card p-6 text-center">
        <p className="text-sm text-blacklight-error">
          Failed to load pools from factory: {error.message}
        </p>
      </section>
    );
  }

  if (pools.length === 0) {
    return (
      <section className="card p-6 text-center">
        <h2 className="mb-2 text-xl font-semibold">Pools</h2>
        <p className="text-sm text-blacklight-text-muted">
          No pools have been created and completed setup yet.        
        </p>
      </section>
    );
  }

  if (isCheckingApprovals) {
    return (
      <>
        {pools.map((pool) => (
          <PoolApprovalChecker
            key={`checker-${pool.pool}`}
            poolAddress={pool.pool}
            operatorAddress={pool.operator}
            onApprovalStatus={updatePoolApprovalStatus(pool.pool)}
          />
        ))}
        <section className="card p-6 text-center">
          <p className="text-sm text-blacklight-text-muted">
            Checking pool status…
          </p>
        </section>
      </>
    );
  }

  if (approvedPools.length === 0) {
    return (
      <section className="card p-6 text-center">
        <h2 className="mb-2 text-xl font-semibold">Pools</h2>
        <p className="text-sm text-blacklight-text-muted">
          No pools have been created and completed setup yet.
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      {pools.map((pool) => (
        <PoolApprovalChecker
          key={`checker-${pool.pool}`}
          poolAddress={pool.pool}
          operatorAddress={pool.operator}
          onApprovalStatus={updatePoolApprovalStatus(pool.pool)}
        />
      ))}
      {isOperatorWallet && <OperatorWalletWarning />}
      <PoolTable
        approvedPools={approvedPools}
        isOperatorWallet={isOperatorWallet}
        onStakeSuccess={onStakeSuccess}
      />
    </section>
  );
}

// Simplified table for public-facing Pools tab
function PoolTable({
  approvedPools,
  isOperatorWallet,
  onStakeSuccess,
}: {
  approvedPools: FactoryPool[];
  isOperatorWallet: boolean;
  onStakeSuccess?: (poolAddress: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-blacklight-border bg-blacklight-card">
      <table className="w-full min-w-[700px] border-collapse">
        <thead>
          <tr className="border-b border-blacklight-border bg-blacklight-surface/50">
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-blacklight-text-muted">
              Pool
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-blacklight-text-muted">
              Commission
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-blacklight-text-muted">
              Stakers No.
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-blacklight-text-muted">
              Staked NIL
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-blacklight-text-muted">
              Min. per staker
            </th>
            <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-blacklight-text-muted">
              Action
            </th>
          </tr>
        </thead>
        <tbody>
          {approvedPools.map((pool) => (
            <PoolTableRow
              key={pool.pool}
              poolAddress={pool.pool}
              operatorAddress={pool.operator}
              isOperatorWallet={isOperatorWallet}
              onStakeSuccess={onStakeSuccess}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

type PoolTableRowProps = {
  poolAddress: `0x${string}`;
  operatorAddress: `0x${string}`;
  isOperatorWallet: boolean;
  onStakeSuccess?: (poolAddress: string) => void;
};

function PoolTableRow({ poolAddress, operatorAddress, isOperatorWallet, onStakeSuccess }: PoolTableRowProps) {
  const { address, isConnected } = useAccount();
  const [quickStakeOpen, setQuickStakeOpen] = useState(false);

  const { data: stakerInfo } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "stakers",
    args: [address!],
    query: { enabled: isConnected && !!address },
  });
  const stakerTuple = stakerInfo as
    | readonly [bigint, bigint, bigint, bigint]
    | undefined;
  const processingStake = stakerTuple?.[0] ?? 0n;
  const stakedAmount = stakerTuple?.[1] ?? 0n;
  const isJoined = processingStake > 0n || stakedAmount > 0n;

  const { data: commissionBps } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "commissionBps",
  });
  const { data: minStakePerUser } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "minStakePerUser",
  });
  const { data: stakerCount } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "stakerCount",
  });
  const { data: totalUserStakes } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "totalUserStakes",
  });
  const { data: poolPhase } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "poolPhase",
  });
  const { data: operatorInfo } = useReadContract({
    address: STAKING_OPERATORS_ADDRESS,
    abi: stakingOperatorsAbi,
    functionName: "getOperatorInfo",
    args: [operatorAddress],
  });

  const operatorMetadataURI =
    operatorInfo !== undefined &&
    operatorInfo !== null &&
    typeof operatorInfo === "object" &&
    "metadataURI" in operatorInfo &&
    typeof (operatorInfo as { metadataURI?: string }).metadataURI === "string"
      ? (operatorInfo as { metadataURI: string }).metadataURI
      : Array.isArray(operatorInfo) &&
          operatorInfo.length >= 2 &&
          typeof operatorInfo[1] === "string"
        ? (operatorInfo[1] as string)
        : "";
  const poolDisplayName = parsePoolDisplayName(operatorMetadataURI, poolAddress);

  const commissionPct =
    commissionBps !== undefined
      ? (Number(commissionBps as bigint) / 100).toFixed(2)
      : "—";

  const minStakeFormatted =
    minStakePerUser !== undefined
      ? Number(formatUnits(minStakePerUser as bigint, NIL_DECIMALS)).toLocaleString(
          undefined,
          { maximumFractionDigits: 2 }
        )
      : "—";

  const stakersDisplay =
    stakerCount !== undefined ? `${stakerCount}/${100}` : "—";

  const stakedNilFormatted =
    totalUserStakes !== undefined
      ? Number(formatUnits(totalUserStakes as bigint, NIL_DECIMALS)).toLocaleString(
          undefined,
          { maximumFractionDigits: 2 }
        )
      : "—";

  const phase = Number(poolPhase);
  const isPoolShuttingDown = phase === POOL_PHASE.ShuttingDown;
  const canStake =
    phase === POOL_PHASE.Active || phase === POOL_PHASE.Idle;

  return (
    <>
      <tr className="border-b border-blacklight-border last:border-b-0 transition-colors hover:bg-blacklight-surface/30">
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="font-medium text-blacklight-text underline decoration-blacklight-accent/50 underline-offset-2">
              {poolDisplayName}
            </span>
            {isJoined && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-blacklight-accent/20 px-2 py-0.5 text-xs font-medium text-blacklight-accent"
                title="You have staked in this pool"
              >
                <svg
                  className="h-3.5 w-3.5"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                  aria-hidden
                >
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
                    clipRule="evenodd"
                  />
                </svg>
                Joined
              </span>
            )}
          </div>
        </td>
        <td className="px-4 py-3 text-sm text-blacklight-text">{commissionPct}%</td>
        <td className="px-4 py-3 text-sm text-blacklight-text font-mono">
          {stakersDisplay}
        </td>
        <td className="px-4 py-3 text-sm text-blacklight-text font-mono">
          {stakedNilFormatted} NIL
        </td>
        <td className="px-4 py-3 text-sm text-blacklight-text font-mono">
          {minStakeFormatted} NIL
        </td>
        <td className="px-4 py-3 text-right">
          <button
            type="button"
            onClick={() => setQuickStakeOpen(true)}
            disabled={isPoolShuttingDown || !canStake || isOperatorWallet}
            title={isOperatorWallet ? "Operator wallets cannot stake" : undefined}
            className="inline-flex items-center rounded-xl bg-blacklight-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blacklight-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            Stake
          </button>
        </td>
      </tr>
      <QuickStakeModal
        open={quickStakeOpen}
        onClose={() => setQuickStakeOpen(false)}
        poolAddress={poolAddress}
        poolDisplayName={poolDisplayName}
        onStakeSuccess={onStakeSuccess}
      />
    </>
  );
}

type PoolListMyPoolsProps = {
  scrollToPoolAddress?: string | null;
  onScrollComplete?: () => void;
};

/** My Pools tab: shows full PoolCard for pools the connected wallet has joined or has pending withdrawals in. */
export function PoolListMyPools({
  scrollToPoolAddress,
  onScrollComplete,
}: PoolListMyPoolsProps = {}) {
  const { address, isConnected } = useAccount();
  const isOperatorWallet = useIsOperatorWallet();
  const { pools, isLoading, error } = useFactoryPools();
  const [poolApprovalStatuses, setPoolApprovalStatuses] = useState<
    Map<string, boolean | null>
  >(new Map());

  const updatePoolApprovalStatus = (poolAddress: string) => {
    return (status: boolean | null) => {
      setPoolApprovalStatuses((prev) => {
        if (prev.get(poolAddress) === status) return prev;
        const next = new Map(prev);
        next.set(poolAddress, status);
        return next;
      });
    };
  };

  const approvedPools = useMemo(() => {
    return pools.filter((pool) => poolApprovalStatuses.get(pool.pool) === true);
  }, [pools, poolApprovalStatuses]);

  const isCheckingApprovals = useMemo(() => {
    if (pools.length === 0) return false;
    return pools.some(
      (pool) =>
        !poolApprovalStatuses.has(pool.pool) ||
        poolApprovalStatuses.get(pool.pool) === null
    );
  }, [pools, poolApprovalStatuses]);

  const stakerContracts = useMemo(() => {
    if (!address) return [];
    return approvedPools.map((pool) => ({
      address: pool.pool as `0x${string}`,
      abi: blacklightPoolAbi,
      functionName: "stakers" as const,
      args: [address] as const,
    }));
  }, [approvedPools, address]);

  const { data: stakerResults } = useReadContracts({
    contracts: stakerContracts,
    query: { enabled: isConnected && !!address && approvedPools.length > 0 },
  });

  const pendingWithdrawalCountContracts = useMemo(() => {
    if (!address) return [];
    return approvedPools.map((pool) => ({
      address: pool.pool as `0x${string}`,
      abi: blacklightPoolAbi,
      functionName: "getPendingWithdrawalRequestCount" as const,
      args: [address] as const,
    }));
  }, [approvedPools, address]);

  const { data: pendingWithdrawalCountResults } = useReadContracts({
    contracts: pendingWithdrawalCountContracts,
    query: { enabled: isConnected && !!address && approvedPools.length > 0 },
  });

  const joinedPools = useMemo(() => {
    if (
      !stakerResults ||
      stakerResults.length !== approvedPools.length ||
      !pendingWithdrawalCountResults ||
      pendingWithdrawalCountResults.length !== approvedPools.length
    ) {
      return [];
    }
    return approvedPools.filter((_, i) => {
      const stakerResult = stakerResults[i];
      const pendingCountResult = pendingWithdrawalCountResults[i];
      if (
        stakerResult?.result === undefined ||
        stakerResult?.result === null ||
        pendingCountResult?.result === undefined ||
        pendingCountResult?.result === null
      ) {
        return false;
      }
      const [proc, staked] = stakerResult.result as readonly [bigint, bigint, bigint, bigint];
      const pendingCount = pendingCountResult.result as bigint;
      return proc > 0n || staked > 0n || pendingCount > 0n;
    });
  }, [approvedPools, stakerResults, pendingWithdrawalCountResults]);

  // Scroll to the staked pool when navigating from QuickStakeModal
  useEffect(() => {
    if (!scrollToPoolAddress || joinedPools.length === 0) return;
    const pool = joinedPools.find(
      (p) => p.pool.toLowerCase() === scrollToPoolAddress.toLowerCase()
    );
    if (!pool) return;
    const id = `pool-card-${pool.pool.toLowerCase()}`;
    const tryScroll = () => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        onScrollComplete?.();
        return true;
      }
      return false;
    };
    if (!tryScroll()) {
      const t = setTimeout(() => {
        tryScroll() || onScrollComplete?.();
      }, 500);
      return () => clearTimeout(t);
    }
  }, [scrollToPoolAddress, joinedPools, onScrollComplete]);

  if (isLoading) {
    return (
      <section className="card p-6 text-center">
        <p className="text-sm text-blacklight-text-muted">Loading pools…</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="card p-6 text-center">
        <p className="text-sm text-blacklight-error">Failed to load pools.</p>
      </section>
    );
  }

  if (!isConnected) {
    return (
      <section className="card p-6 text-center">
        <h2 className="mb-2 text-xl font-semibold">My Pools</h2>
        <p className="text-sm text-blacklight-text-muted">
          Connect your wallet to see pools you have joined.
        </p>
      </section>
    );
  }

  if (pools.length === 0 || isCheckingApprovals) {
    return (
      <>
        {pools.map((pool) => (
          <PoolApprovalChecker
            key={`my-checker-${pool.pool}`}
            poolAddress={pool.pool}
            operatorAddress={pool.operator}
            onApprovalStatus={updatePoolApprovalStatus(pool.pool)}
            includeShuttingDown
          />
        ))}
        <section className="card p-6 text-center">
          <p className="text-sm text-blacklight-text-muted">
            {isCheckingApprovals ? "Checking pool status…" : "No pools available."}
          </p>
        </section>
      </>
    );
  }

  if (joinedPools.length === 0) {
    return (
      <>
        {pools.map((pool) => (
          <PoolApprovalChecker
            key={`my-checker-${pool.pool}`}
            poolAddress={pool.pool}
            operatorAddress={pool.operator}
            onApprovalStatus={updatePoolApprovalStatus(pool.pool)}
            includeShuttingDown
          />
        ))}
        <section className="card p-6 text-center">
          <h2 className="mb-2 text-xl font-semibold">My Pools</h2>
          <p className="text-sm text-blacklight-text-muted">
            You haven&apos;t joined any pools yet. Use the Pools tab to stake.
          </p>
        </section>
      </>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      {pools.map((pool) => (
        <PoolApprovalChecker
          key={`my-checker-${pool.pool}`}
          poolAddress={pool.pool}
          operatorAddress={pool.operator}
          onApprovalStatus={updatePoolApprovalStatus(pool.pool)}
          includeShuttingDown
        />
      ))}
      {isOperatorWallet && <OperatorWalletWarning />}
      {/* How-to panel shown at the top of My Pools when the user has at least one joined pool */}
      <section className="card p-6">
        <h2 className="mb-2 text-lg font-semibold">How to stake and withdraw</h2>
        <p className="mb-3 text-sm text-blacklight-text-muted">
          Use the forms on each pool to add NIL or take it out:
        </p>
        <div className="space-y-2 text-sm text-blacklight-text-muted">
          <p>
            <span className="font-semibold text-blacklight-text">Stake</span>{" "}
            — Enter amount → approve NIL (if needed) → stake to pool. Funds stay in the pool
            until the platform keeper forwards them to the node.
          </p>
          <p>
            <span className="font-semibold text-blacklight-text">Withdraw</span>{" "}
            - Withdraw any{" "}
            <span className="font-semibold">processing stake</span>{" "}
            (NIL that is still sitting in the pool and has not yet been staked to the node);
            this part is sent to your wallet immediately. For any remaining amount that is
            already staked in an <span className="font-semibold">active</span> pool,
            wait ~8 days (7-day unbonding + 1-day processing buffer) →
            <span className="font-semibold"> Claim</span> to receive NIL in your wallet.
          </p>
        </div>
      </section>
      {joinedPools.map((pool) => (
        <PoolCard
          key={pool.pool}
          poolAddress={pool.pool}
          operatorAddress={pool.operator}
          isOperatorWallet={isOperatorWallet}
          id={`pool-card-${pool.pool.toLowerCase()}`}
        />
      ))}
    </section>
  );
}

type PoolCardProps = {
  poolAddress: `0x${string}`;
  operatorAddress: `0x${string}`;
  isOperatorWallet?: boolean;
  id?: string;
};

function PoolCard({ poolAddress, operatorAddress, isOperatorWallet, id }: PoolCardProps) {
  const { address, isConnected } = useAccount();

  // Connected user's balance in this pool (for "Your balance in pool" above the two panels)
  const { data: stakerInfo } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "stakers",
    args: [address!],
    query: { enabled: isConnected && !!address },
  });
  const { data: pendingWithdrawalSum } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "getPendingWithdrawalSum",
    args: [address!],
    query: { enabled: isConnected && !!address },
  });
  const stakerTuple = stakerInfo as readonly [bigint, bigint, bigint, bigint] | undefined;
  const processingStake = stakerTuple?.[0] ?? 0n;
  const stakedAmount = stakerTuple?.[1] ?? 0n;
  const processingUnstake = typeof pendingWithdrawalSum === "bigint" ? pendingWithdrawalSum : 0n;
  const userBalanceInPool = stakerTuple != null ? processingStake + stakedAmount : undefined;

  const [helpTooltip, setHelpTooltip] = useState<
    "processing-stake" | "processing-unstake" | null
  >(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | number | null>(null);
  const tooltipPopoverRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    };
  }, []);

  const handleHelpMouseLeave = (e: React.MouseEvent) => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    if (tooltipPopoverRef.current?.contains(e.relatedTarget as Node)) return;
    setHelpTooltip(null);
  };

  // Basic pool config
  const { data: commissionBps } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "commissionBps",
  });

  const { data: minStakePerUser } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "minStakePerUser",
  });

  const { data: totalUserStakes } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "totalUserStakes",
  });

  const { data: poolPhase } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "poolPhase",
  });

  const { data: shutdownStatus } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "getShutdownStatus",
    // For status display we only need to know if shutdown is pending;
    // passing the zero address avoids coupling to the connected wallet.
    args: ["0x0000000000000000000000000000000000000000"],
  });

  // Node stake and status via StakingOperators
  const { data: nodeStake } = useReadContract({
    address: STAKING_OPERATORS_ADDRESS,
    abi: stakingOperatorsAbi,
    functionName: "stakeOf",
    args: [operatorAddress],
  });

  const { data: approvedStaker } = useReadContract({
    address: STAKING_OPERATORS_ADDRESS,
    abi: stakingOperatorsAbi,
    functionName: "approvedStaker",
    args: [operatorAddress],
  });

  const { data: isActive } = useReadContract({
    address: STAKING_OPERATORS_ADDRESS,
    abi: stakingOperatorsAbi,
    functionName: "isActiveOperator",
    args: [operatorAddress],
  });

  const explicitlyApproved =
    approvedStaker !== undefined &&
    (approvedStaker as string).toLowerCase() === poolAddress.toLowerCase();
  // Fallback: operator active + node has stake means pool forwarded stake, so setup is complete
  // (approvedStaker can return zero on some StakingOperators implementations after registration)
  const isPoolApproved =
    explicitlyApproved ||
    (isActive === true &&
      nodeStake !== undefined &&
      (nodeStake as bigint) > 0n);
  const isApprovalLoaded = approvedStaker !== undefined;

  const { data: operatorInfo } = useReadContract({
    address: STAKING_OPERATORS_ADDRESS,
    abi: stakingOperatorsAbi,
    functionName: "getOperatorInfo",
    args: [operatorAddress],
  });

  const operatorMetadataURI =
    operatorInfo !== undefined &&
    operatorInfo !== null &&
    typeof operatorInfo === "object" &&
    "metadataURI" in operatorInfo &&
    typeof (operatorInfo as { metadataURI?: string }).metadataURI === "string"
      ? (operatorInfo as { metadataURI: string }).metadataURI
      : Array.isArray(operatorInfo) && operatorInfo.length >= 2 && typeof operatorInfo[1] === "string"
        ? (operatorInfo[1] as string)
        : "";

  const poolDisplayName = parsePoolDisplayName(operatorMetadataURI, poolAddress);

  const shutdownTuple = shutdownStatus as
    | readonly [boolean, bigint, bigint, boolean]
    | undefined;
  const shutdownPending = shutdownTuple?.[0] ?? false;
  const isPoolShuttingDown =
    poolPhase !== undefined && Number(poolPhase) === POOL_PHASE.ShuttingDown;

  const fmt = (val: bigint | undefined) =>
    val !== undefined
      ? Number(formatUnits(val, NIL_DECIMALS)).toLocaleString(undefined, {
          maximumFractionDigits: 2,
        })
      : "—";

  const commissionPct =
    commissionBps !== undefined
      ? (Number(commissionBps as bigint) / 100).toFixed(2)
      : "—";

  return (
    <article id={id} className="card p-6">
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
        <div className="space-y-1">
          <h3 className="text-lg font-semibold text-blacklight-text">
            {poolDisplayName}
          </h3>
          <p className="text-sm text-blacklight-text-muted break-all">
            Contract: <span className="font-mono">{poolAddress}</span>
          </p>
          <p className="text-sm text-blacklight-text-muted break-all">
            Operator: <span className="font-mono">{operatorAddress}</span>
          </p>
        </div>
        <div className="text-right text-xs">
          <p>
            Commission:{" "}
            <span className="font-mono text-blacklight-accent">
              {commissionPct}%
            </span>
          </p>
          <p>
            Min stake per user:{" "}
            <span className="font-mono">
              {minStakePerUser !== undefined
                ? Number(formatUnits(minStakePerUser as bigint, NIL_DECIMALS)).toLocaleString(
                    undefined,
                    { maximumFractionDigits: 2 }
                  )
                : "—"}{" "}
              NIL
            </span>
          </p>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-4 text-sm">
        <div>
          <p className="stat-label">Node Stake</p>
          <p className="stat-value">{fmt(nodeStake as bigint)} NIL</p>
        </div>
        <div>
          <p className="stat-label">Node Status</p>
          <p className="stat-value">
            {poolPhase !== undefined && Number(poolPhase) === POOL_PHASE.ShuttingDown ? (
              <span className="text-blacklight-error">Shut down</span>
            ) : shutdownPending ? (
              <span className="text-blacklight-accent">Shutting down</span>
            ) : isActive === undefined ? (
              "—"
            ) : isActive ? (
              <span className="text-blacklight-success">Active</span>
            ) : (
              <span className="text-blacklight-warning">Inactive</span>
            )}
          </p>
        </div>
      </div>

      {!isApprovalLoaded ? (
        <div className="rounded-xl border border-blacklight-border bg-blacklight-surface/50 p-4 text-center text-sm text-blacklight-text-muted">
          Checking pool status…
        </div>
      ) : !isPoolShuttingDown &&
        nodeStake !== undefined &&
        (nodeStake as bigint) < MIN_NODE_STAKE ? (
        <div className="rounded-xl border border-blacklight-error bg-blacklight-error/20 p-4">
          <h3 className="mb-2 text-sm font-semibold text-blacklight-error">
            Node stake below 70,000 NIL
          </h3>
          <p className="text-sm text-blacklight-text-muted">
            The operator node has{" "}
            <span className="font-mono text-blacklight-text">
              {fmt(nodeStake as bigint)} NIL
            </span>{" "}
            staked. At least 70,000 NIL must be staked to the node for it to become
            active. Add more NIL to the pool and have the owner call{" "}
            <strong>Activate operator</strong> (or stake to node) so the node
            reaches the minimum.
          </p>
          <p className="mt-2 text-xs text-blacklight-text-muted">
            Operator: <code className="rounded bg-blacklight-surface px-1 py-0.5 font-mono">{operatorAddress}</code>
          </p>
        </div>
      ) : !isPoolShuttingDown && !isPoolApproved ? (
        <div className="rounded-xl border border-blacklight-error bg-blacklight-error/20 p-4">
          <h3 className="mb-2 text-sm font-semibold text-blacklight-error">
            Pool setup incomplete
          </h3>
          <p className="text-sm text-blacklight-text-muted">
            The operator must approve this pool as a staker before anyone can stake
            or withdraw. Complete{" "}
            <strong>Step 3: Operator approves staker</strong> in the Create Pool
            wizard above.
          </p>
          <p className="mt-2 text-xs text-blacklight-text-muted">
            Operator: <code className="rounded bg-blacklight-surface px-1 py-0.5 font-mono">{operatorAddress}</code>
          </p>
        </div>
      ) : isOperatorWallet ? (
        <div className="rounded-xl border border-blacklight-warning bg-blacklight-warning/10 p-4 text-center">
          <p className="text-sm text-blacklight-warning font-medium">
            Operator wallets cannot stake or withdraw. Switch to a different wallet to manage your position.
          </p>
        </div>
      ) : (
        <>
          {isConnected && (
            <div className="mb-4">
              <p className="text-xl font-semibold text-blacklight-text mb-2">Your balance in pool:</p>
              <div className="space-y-1 text-sm text-blacklight-text-muted">
                <p>
                  Processing stake{" "}
                  <span className="relative inline-flex align-middle">
                    <span
                      role="button"
                      tabIndex={0}
                      className="inline-flex cursor-help text-blacklight-text-muted hover:text-blacklight-text focus:outline-none focus:ring-2 focus:ring-blacklight-primary rounded"
                      aria-label="Help: processing stake"
                      aria-expanded={helpTooltip === "processing-stake"}
                      onMouseEnter={() => {
                        hoverTimeoutRef.current = window.setTimeout(
                          () => setHelpTooltip("processing-stake"),
                          300
                        );
                      }}
                      onMouseLeave={handleHelpMouseLeave}
                      onFocus={() => setHelpTooltip("processing-stake")}
                      onBlur={() => setHelpTooltip(null)}
                      onClick={(e) => {
                        e.preventDefault();
                        setHelpTooltip((prev) =>
                          prev === "processing-stake" ? null : "processing-stake"
                        );
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setHelpTooltip((prev) =>
                            prev === "processing-stake" ? null : "processing-stake"
                          );
                        }
                      }}
                    >
                      <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20" aria-hidden>
                        <path
                          fillRule="evenodd"
                          d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-3a1 1 0 00-.867.5 1 1 0 11-1.731-.5A3 3 0 0113 8a3.001 3.001 0 01-2 2.83V11a1 1 0 11-2 0v-1a1 1 0 011-1 1 1 0 100-2zm0 8a1 1 0 100-2 1 1 0 000 2z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </span>
                    {helpTooltip === "processing-stake" && (
                      <span
                        ref={tooltipPopoverRef}
                        className="absolute left-0 top-full mt-1.5 z-50 w-72 rounded-lg border border-blacklight-border bg-blacklight-surface px-3 py-2 text-xs font-normal text-blacklight-text shadow-lg"
                        role="tooltip"
                        onMouseLeave={handleHelpMouseLeave}
                      >
                        NIL you deposited that has not yet been forwarded to the node. The pool
                        owner or any keeper will process it to move it to &quot;Staked&quot;. You can
                        withdraw it anytime with &quot;Withdraw processing stake&quot;.
                      </span>
                    )}
                  </span>
                  :{" "}
                  <span className="font-mono text-blacklight-text">
                    {stakerTuple !== undefined
                      ? `${Number(formatUnits(processingStake, NIL_DECIMALS)).toLocaleString(undefined, { maximumFractionDigits: 2 })} NIL`
                      : "—"}
                  </span>
                </p>
                <p>
                  Staked:{" "}
                  <span className="font-mono text-blacklight-text">
                    {stakerTuple !== undefined
                      ? `${Number(formatUnits(stakedAmount, NIL_DECIMALS)).toLocaleString(undefined, { maximumFractionDigits: 2 })} NIL`
                      : "—"}
                  </span>
                </p>
                {processingUnstake > 0n && (
                  <p>
                    Processing unstake{" "}
                    <span className="relative inline-flex align-middle">
                      <span
                        role="button"
                        tabIndex={0}
                        className="inline-flex cursor-help text-blacklight-text-muted hover:text-blacklight-text focus:outline-none focus:ring-2 focus:ring-blacklight-primary rounded"
                        aria-label="Help: processing unstake"
                        aria-expanded={helpTooltip === "processing-unstake"}
                        onMouseEnter={() => {
                          hoverTimeoutRef.current = window.setTimeout(
                            () => setHelpTooltip("processing-unstake"),
                            300
                          );
                        }}
                        onMouseLeave={handleHelpMouseLeave}
                        onFocus={() => setHelpTooltip("processing-unstake")}
                        onBlur={() => setHelpTooltip(null)}
                        onClick={(e) => {
                          e.preventDefault();
                          setHelpTooltip((prev) =>
                            prev === "processing-unstake" ? null : "processing-unstake"
                          );
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setHelpTooltip((prev) =>
                              prev === "processing-unstake" ? null : "processing-unstake"
                            );
                          }
                        }}
                      >
                        <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20" aria-hidden>
                          <path
                            fillRule="evenodd"
                            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-3a1 1 0 00-.867.5 1 1 0 11-1.731-.5A3 3 0 0113 8a3.001 3.001 0 01-2 2.83V11a1 1 0 11-2 0v-1a1 1 0 011-1 1 1 0 100-2zm0 8a1 1 0 100-2 1 1 0 000 2z"
                            clipRule="evenodd"
                          />
                        </svg>
                      </span>
                      {helpTooltip === "processing-unstake" && (
                        <span
                          ref={tooltipPopoverRef}
                          className="absolute left-0 top-full mt-1.5 z-50 w-72 rounded-lg border border-blacklight-border bg-blacklight-surface px-3 py-2 text-xs font-normal text-blacklight-text shadow-lg"
                          role="tooltip"
                          onMouseLeave={handleHelpMouseLeave}
                        >
                          NIL you requested to withdraw that is being unstaked from the node. A
                          keeper will process the batch; then there is a 7-day unbonding period
                          plus a 1-day claim buffer. After that you can claim to your wallet.
                        </span>
                      )}
                    </span>
                    :{" "}
                    <span className="font-mono text-blacklight-error">
                      {Number(formatUnits(processingUnstake, NIL_DECIMALS)).toLocaleString(undefined, {
                        maximumFractionDigits: 2,
                      })}{" "}
                      NIL
                    </span>
                  </p>
                )}
              </div>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <StakeForm poolAddress={poolAddress} />
            <WithdrawForm poolAddress={poolAddress} />
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <section className="card p-6">
              <h2 className="mb-2 text-xl font-semibold">Rewards History</h2>
              <p className="text-xs text-blacklight-text-muted">
                Shows NIL rewards paid from this pool to your wallet over roughly the
                last 12 hours of on-chain activity (up to 10 most recent transfers).
              </p>
              <RewardsHistory poolAddress={poolAddress} />
            </section>
            <UnbondingStakePanel poolAddress={poolAddress} />
          </div>

          <div className="mt-6 space-y-6">
            <ShutdownOperations poolAddress={poolAddress} />
          </div>
        </>
      )}
    </article>
  );
}

type RewardEntry = {
  txHash: `0x${string}`;
  amount: bigint;
  timestamp?: number;
};

function RewardsHistory({ poolAddress }: { poolAddress: `0x${string}` }) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const [entries, setEntries] = useState<RewardEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const client = publicClient;
    if (!address || !client) return;

    let cancelled = false;

    async function load() {
      try {
        setIsLoading(true);
        setError(null);

        const latestBlock = await client!.getBlock({ blockTag: "latest" });
        const latestNumber = latestBlock.number ?? 0n;

        // Approximate 12 hours of blocks. If block time is ~2 seconds, 12h ≈ 21,600 blocks.
        const approxBlocksFor12h = 21_600n;
        const fromBlock =
          latestNumber > approxBlocksFor12h
            ? latestNumber - approxBlocksFor12h
            : 0n;

        const transferEvent = (nilTokenAbi as unknown as AbiEvent[]).find(
          (item) => item.type === "event" && item.name === "Transfer",
        ) as AbiEvent | undefined;

        const epochSettledEvent = (blacklightPoolAbi as unknown as AbiEvent[]).find(
          (item) => item.type === "event" && item.name === "EpochSettled",
        ) as AbiEvent | undefined;

        if (!transferEvent || !epochSettledEvent) {
          throw new Error("Required events not found in ABI");
        }

        const logs = await client!.getLogs({
          address: NIL_TOKEN_ADDRESS,
          event: transferEvent,
          // Filter to rewards paid from pool to this wallet
          args: {
            from: poolAddress,
            to: address,
          } as any,
          fromBlock,
          toBlock: latestNumber,
        });

        if (cancelled) return;

        // Get all EpochSettled events for this pool in the same 12h window
        const epochLogs = await client!.getLogs({
          address: poolAddress,
          event: epochSettledEvent,
          fromBlock,
          toBlock: latestNumber,
        });

        if (cancelled) return;

        const epochTxHashes = new Set<string>(
          epochLogs
            .map((l) => l.transactionHash)
            .filter((h): h is `0x${string}` => !!h),
        );

        // Keep only transfers whose tx also emitted EpochSettled on this pool
        const classified: {
          txHash: `0x${string}`;
          amount: bigint;
          blockNumber: bigint;
          logIndex: bigint;
        }[] = [];

        for (const log of logs) {
          const txHash = log.transactionHash!;
          if (!epochTxHashes.has(txHash)) {
            continue;
          }
          const blockNumber = log.blockNumber ?? latestNumber;

          classified.push({
            txHash,
            amount: (log as any).args.value as bigint,
            blockNumber,
            logIndex: BigInt((log.logIndex ?? 0) as number),
          });
        }

        const minRewardDisplay = parseUnits("0.001", NIL_DECIMALS);

        const sorted = classified
          .filter((c) => c.amount >= minRewardDisplay)
          .sort((a, b) => {
            if (a.blockNumber === b.blockNumber) {
              return Number(b.logIndex - a.logIndex);
            }
            return Number(b.blockNumber - a.blockNumber);
          })
          .slice(0, 10);

        // Fetch block timestamps for unique blocks
        const uniqueBlocks = [...new Set(sorted.map((r) => r.blockNumber))];
        const blockTimes = new Map<bigint, number>();
        for (const bn of uniqueBlocks) {
          if (cancelled) return;
          try {
            const block = await client!.getBlock({ blockNumber: bn });
            blockTimes.set(bn, Number(block.timestamp ?? 0));
          } catch {
            // Skip if block fetch fails
          }
        }

        const rewards: RewardEntry[] = sorted.map(({ txHash, amount, blockNumber }) => ({
          txHash,
          amount,
          timestamp: blockTimes.get(blockNumber),
        }));

        setEntries(rewards);
      } catch (e) {
        if (cancelled) return;
        setError(
          e instanceof Error ? e.message : "Failed to load reward history.",
        );
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [address, poolAddress, publicClient]);

  if (!address) {
    return (
      <p className="mt-3 text-xs text-blacklight-text-muted">
        Connect your wallet to see your recent rewards from this pool.
      </p>
    );
  }

  if (isLoading) {
    return (
      <p className="mt-3 text-xs text-blacklight-text-muted">
        Loading recent rewards…
      </p>
    );
  }

  if (error) {
    return (
      <p className="mt-3 text-xs text-blacklight-error">
        {error}
      </p>
    );
  }

  if (entries.length === 0) {
    return (
      <p className="mt-3 text-xs text-blacklight-text-muted">
        No NIL rewards found from this pool to your wallet in the last ~12 hours.
      </p>
    );
  }

  return (
    <ul className="mt-3 space-y-2 text-xs text-blacklight-text-muted">
      {entries.map((entry) => (
        <li
          key={entry.txHash}
          className="flex items-center justify-between gap-3 rounded-lg border border-blacklight-border bg-blacklight-surface/50 px-3 py-2"
        >
          <span className="font-mono text-blacklight-text">
            {Number(
              formatUnits(entry.amount, NIL_DECIMALS),
            ).toLocaleString(undefined, { maximumFractionDigits: 4 })}{" "}
            NIL
          </span>
          <span className="shrink-0 text-[11px] text-blacklight-text-muted">
            {entry.timestamp != null
              ? new Date(entry.timestamp * 1000).toLocaleString()
              : `${entry.txHash.slice(0, 10)}…${entry.txHash.slice(-6)}`}
          </span>
        </li>
      ))}
    </ul>
  );
}
