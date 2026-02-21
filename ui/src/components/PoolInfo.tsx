"use client";

import { useAccount, useReadContract } from "wagmi";
import {
  NIL_TOKEN_ADDRESS,
  NIL_DECIMALS,
  nilTokenAbi,
  STAKING_OPERATORS_ADDRESS,
  stakingOperatorsAbi,
} from "@/lib/contracts";
import { formatUnits } from "viem";

/**
 * Displays high-level pool stats:
 * - Total NIL staked to the operator node
 * - Pool's idle NIL balance
 * - Whether the pool has met the 70k minimum
 * - Connected user's NIL balance
 */
export function PoolInfo() {
  const { address, isConnected } = useAccount();

  // NOTE:
  // Single-pool defaults using OPERATOR_ADDRESS and POOL_CONTRACT_ADDRESS have
  // been removed. These values are currently unused in this build, so we
  // replace them with placeholders to keep the UI compiling without relying on
  // non-existent contract exports.
  const nodeStake: bigint | undefined = undefined;
  const poolBalance: bigint | undefined = undefined;

  // Connected user's NIL wallet balance
  const { data: userBalance } = useReadContract({
    address: NIL_TOKEN_ADDRESS,
    abi: nilTokenAbi,
    functionName: "balanceOf",
    args: [address!],
    query: { enabled: isConnected && !!address },
  });

  // Whether the operator is active (placeholder until multi-pool wiring)
  const isActive: boolean | undefined = undefined;

  const fmt = (val: bigint | undefined) =>
    val !== undefined
      ? Number(formatUnits(val, NIL_DECIMALS)).toLocaleString(undefined, {
          maximumFractionDigits: 2,
        })
      : "—";

  const stakeNum = nodeStake !== undefined ? Number(formatUnits(nodeStake, NIL_DECIMALS)) : 0;
  const threshold = 70_000;
  const progress = Math.min((stakeNum / threshold) * 100, 100);

  return (
    <section className="card p-6">
      <h2 className="mb-4 text-xl font-semibold">Pool Overview</h2>

      {/* Progress to 70k */}
      <div className="mb-6">
        <div className="mb-1 flex items-center justify-between text-sm">
          <span className="text-blacklight-text-muted">
            Progress to 70,000 NIL minimum
          </span>
          <span className="font-mono text-blacklight-accent">
            {progress.toFixed(1)}%
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-blacklight-surface">
          <div
            className="h-full rounded-full bg-blacklight-accent transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div>
          <p className="stat-label">Staked to Node</p>
          <p className="stat-value">{fmt(nodeStake)} NIL</p>
        </div>
        <div>
          <p className="stat-label">Pool Idle Balance</p>
          <p className="stat-value">{fmt(poolBalance)} NIL</p>
        </div>
        <div>
          <p className="stat-label">Node Status</p>
          <p className="stat-value">
            {isActive === undefined ? (
              "—"
            ) : isActive ? (
              <span className="text-blacklight-success">Active</span>
            ) : (
              <span className="text-blacklight-warning">Inactive</span>
            )}
          </p>
        </div>
        {isConnected && (
          <div>
            <p className="stat-label">Your NIL Balance</p>
            <p className="stat-value">{fmt(userBalance as bigint | undefined)} NIL</p>
          </div>
        )}
      </div>
    </section>
  );
}
