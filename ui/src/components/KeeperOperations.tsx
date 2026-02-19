"use client";

import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useBlockTimestamp } from "@/hooks/useBlockTimestamp";
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { formatUnits } from "viem";
import {
  blacklightPoolAbi,
  NIL_DECIMALS,
  STAKING_OPERATORS_ADDRESS,
  stakingOperatorsAbi,
  rewardPolicyRewardsAbi,
} from "@/lib/contracts";

type KeeperOperationsProps = {
  poolAddress: `0x${string}`;
};

/**
 * Permissionless keeper operations (forwardStakeToNode, processWithdrawalBatch,
 * pullUnstakedFromStaking, processUserWithdrawals, settleEpoch). Exposed in the UI
 * only to the platform fee recipient wallet, so the platform operator can run
 * these operations from the dapp.
 */
export function KeeperOperations({ poolAddress }: KeeperOperationsProps) {
  const { address, isConnected } = useAccount();
  const queryClient = useQueryClient();
  const [maxEntries, setMaxEntries] = useState("50");
  const [userAddress, setUserAddress] = useState("");

  const { data: platformFeeRecipient } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "platformFeeRecipient",
    query: { enabled: !!poolAddress },
  });

  const { data: poolOperator } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "operator",
    query: { enabled: !!poolAddress },
  });

  const { data: unbondingTranches } = useReadContract({
    address: STAKING_OPERATORS_ADDRESS,
    abi: stakingOperatorsAbi,
    functionName: "getUnbondingTranches",
    args: [poolOperator as `0x${string}`],
    query: { enabled: !!poolAddress && !!poolOperator },
  });

  const { data: totalPendingWithdrawals } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "totalPendingWithdrawals",
    query: { enabled: !!poolAddress },
  });

  const { data: pendingWithdrawalRequestCount } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "totalPendingWithdrawalRequestCount",
    query: { enabled: !!poolAddress },
  });

  const { data: rewardPolicyAddr } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "rewardPolicy",
    query: { enabled: !!poolAddress },
  });

  const { data: unclaimedRewards } = useReadContract({
    address: rewardPolicyAddr as `0x${string}`,
    abi: rewardPolicyRewardsAbi,
    functionName: "rewards",
    args: [poolAddress],
    query: { enabled: !!poolAddress && !!rewardPolicyAddr },
  });

  const { data: totalProcessingStake } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "totalProcessingStake",
    query: { enabled: !!poolAddress },
  });

  const { data: shutdownInitiatedAt } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "shutdownInitiatedAt",
    query: { enabled: !!poolAddress },
  });

  const nowSeconds = useBlockTimestamp();
  const pullable = (() => {
    const t = unbondingTranches;
    if (!t || !Array.isArray(t)) return { hasMatured: false, amount: 0n };
    let sum = 0n;
    for (const row of t) {
      const amount = Array.isArray(row) ? row[0] : (row as { amount: bigint }).amount;
      const releaseTime = Array.isArray(row) ? Number(row[1]) : Number((row as { releaseTime: number }).releaseTime);
      if (releaseTime <= nowSeconds) sum += typeof amount === "bigint" ? amount : BigInt(amount ?? 0);
    }
    return { hasMatured: sum > 0n, amount: sum };
  })();

  const {
    writeContract: writeProcessBatch,
    data: processBatchTxHash,
    isPending: isProcessBatchPending,
  } = useWriteContract();

  const {
    writeContract: writePullUnstaked,
    data: pullUnstakedTxHash,
    isPending: isPullUnstakedPending,
  } = useWriteContract();

  const {
    writeContract: writeProcessUserWithdrawals,
    data: processUserTxHash,
    isPending: isProcessUserPending,
  } = useWriteContract();

  const {
    writeContract: writeSettleEpoch,
    data: settleEpochTxHash,
    isPending: isSettleEpochPending,
  } = useWriteContract();

  const {
    writeContract: writeForwardStake,
    data: forwardTxHash,
    isPending: isForwardPending,
  } = useWriteContract();

  const { isLoading: isForwardConfirming, isSuccess: isForwardConfirmed } =
    useWaitForTransactionReceipt({ hash: forwardTxHash });

  const { isLoading: isProcessBatchConfirming, isSuccess: isProcessBatchConfirmed } =
    useWaitForTransactionReceipt({ hash: processBatchTxHash });
  const { isLoading: isPullUnstakedConfirming, isSuccess: isPullUnstakedConfirmed } =
    useWaitForTransactionReceipt({ hash: pullUnstakedTxHash });
  const { isLoading: isProcessUserConfirming, isSuccess: isProcessUserConfirmed } =
    useWaitForTransactionReceipt({ hash: processUserTxHash });
  const { isLoading: isSettleEpochConfirming, isSuccess: isSettleEpochConfirmed } =
    useWaitForTransactionReceipt({ hash: settleEpochTxHash });

  // Invalidate queries after successful processWithdrawalBatch so pending counts refresh
  useEffect(() => {
    if (isProcessBatchConfirmed) {
      queryClient.invalidateQueries({
        predicate: (query) =>
          JSON.stringify(query.queryKey).includes(poolAddress),
      });
    }
  }, [isProcessBatchConfirmed, queryClient, poolAddress]);

  // Invalidate queries after successful pullUnstakedFromStaking to refresh unbondingTranches
  useEffect(() => {
    if (isPullUnstakedConfirmed) {
      // Invalidate unbondingTranches query to refresh the pullable status
      queryClient.invalidateQueries({
        predicate: (query) =>
          JSON.stringify(query.queryKey).includes(STAKING_OPERATORS_ADDRESS.toLowerCase()) &&
          JSON.stringify(query.queryKey).includes("getUnbondingTranches"),
      });
      
      // Also invalidate pool-related queries since pullUnstakedFromStaking affects pool state
      queryClient.invalidateQueries({
        predicate: (query) =>
          JSON.stringify(query.queryKey).includes(poolAddress),
      });
    }
  }, [isPullUnstakedConfirmed, queryClient, poolAddress]);

  // Invalidate after forwardStakeToNode so Node Stake and processing stake refresh
  useEffect(() => {
    if (isForwardConfirmed) {
      queryClient.invalidateQueries({
        predicate: (query) =>
          JSON.stringify(query.queryKey).includes(poolAddress),
      });
      queryClient.invalidateQueries({
        predicate: (query) =>
          JSON.stringify(query.queryKey).includes(STAKING_OPERATORS_ADDRESS.toLowerCase()),
      });
    }
  }, [isForwardConfirmed, queryClient, poolAddress]);

  const isPlatformFeeRecipient =
    isConnected &&
    !!address &&
    !!platformFeeRecipient &&
    address.toLowerCase() === (platformFeeRecipient as string).toLowerCase();

  if (!isConnected || !address) {
    return null;
  }

  if (!isPlatformFeeRecipient) {
    return null;
  }

  const parsedMaxEntries = parseInt(maxEntries, 10) || 50;
  const isValidUser =
    userAddress.length === 42 &&
    userAddress.startsWith("0x");

  function handleProcessWithdrawalBatch() {
    writeProcessBatch({
      address: poolAddress,
      abi: blacklightPoolAbi,
      functionName: "processWithdrawalBatch",
      args: [BigInt(Math.max(1, Math.min(parsedMaxEntries, 200)))],
    });
  }

  function handlePullUnstakedFromStaking() {
    writePullUnstaked({
      address: poolAddress,
      abi: blacklightPoolAbi,
      functionName: "pullUnstakedFromStaking",
      args: [],
    });
  }

  function handleProcessUserWithdrawals() {
    if (!isValidUser) return;
    writeProcessUserWithdrawals({
      address: poolAddress,
      abi: blacklightPoolAbi,
      functionName: "processUserWithdrawals",
      args: [userAddress as `0x${string}`],
    });
  }

  function handleSettleEpoch() {
    writeSettleEpoch({
      address: poolAddress,
      abi: blacklightPoolAbi,
      functionName: "settleEpoch",
      args: [],
    });
  }

  const hasProcessingStake =
    totalProcessingStake !== undefined &&
    totalProcessingStake !== null &&
    (totalProcessingStake as bigint) > 0n;
  const isShutdownPending =
    shutdownInitiatedAt !== undefined && (shutdownInitiatedAt as bigint) > 0n;

  function handleForwardStakeToNode() {
    writeForwardStake({
      address: poolAddress,
      abi: blacklightPoolAbi,
      functionName: "forwardStakeToNode",
      args: [],
    });
  }

  return (
    <section className="card p-4 border-2 border-blacklight-accent/30">
      <h3 className="mb-2 text-sm font-semibold text-blacklight-accent">
        Keeper Operations (Platform Fee Recipient)
      </h3>
      {platformFeeRecipient && (
        <p className="mb-1 text-xs text-blacklight-text-muted">
          Platform fee recipient (keeper):{" "}
          <code className="rounded bg-blacklight-surface px-1 py-0.5 font-mono">
            {typeof platformFeeRecipient === "string"
              ? platformFeeRecipient
              : String(platformFeeRecipient)}
          </code>
        </p>
      )}
      <p className="mb-3 text-xs text-blacklight-text-muted">
        Permissionless operations exposed to the platform fee recipient wallet.
        Forward Stake to Node moves all processing stake to the staking contract (anyone may call on-chain; shown here for keepers). Pending for batch:{" "}
        {pendingWithdrawalRequestCount !== undefined
          ? `${pendingWithdrawalRequestCount.toLocaleString()} request${Number(pendingWithdrawalRequestCount) === 1 ? "" : "s"}`
          : "—"}
        {totalPendingWithdrawals !== undefined && (totalPendingWithdrawals as bigint) > 0n && (
          <>
            {" "}
            (
            {Number(formatUnits(totalPendingWithdrawals as bigint, NIL_DECIMALS)).toLocaleString(
              undefined,
              { maximumFractionDigits: 2 }
            )}{" "}
            NIL)
          </>
        )}
      </p>

      <div className="space-y-4">
        <div>
          <h4 className="mb-2 text-xs font-semibold text-blacklight-text">
            Forward Stake to Node
          </h4>
          <p className="mb-2 text-xs text-blacklight-text-muted">
            Move all current processing stake from the pool to the staking contract so it earns rewards at the node. Permissionless on-chain; no funds go to the caller.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <p className="text-sm text-blacklight-text-muted">
              Processing stake to forward:{" "}
              <span className="font-mono text-blacklight-text">
                {totalProcessingStake !== undefined
                  ? Number(
                      formatUnits(totalProcessingStake as bigint, NIL_DECIMALS)
                    ).toLocaleString(undefined, { maximumFractionDigits: 2 })
                  : "—"}{" "}
                NIL
              </span>
            </p>
            <button
              onClick={handleForwardStakeToNode}
              disabled={
                isForwardPending ||
                isForwardConfirming ||
                !hasProcessingStake ||
                isShutdownPending
              }
              className="btn-secondary whitespace-nowrap"
            >
              {isForwardPending || isForwardConfirming
                ? "Forwarding…"
                : "Forward Stake to Node"}
            </button>
          </div>
          {isShutdownPending && (
            <p className="mt-1 text-xs text-blacklight-warning">
              Shutdown initiated — forwarding stake is disabled during the cooling-off period.
            </p>
          )}
          {!hasProcessingStake && !isShutdownPending && (
            <p className="mt-1 text-xs text-blacklight-text-muted">
              No processing stake to forward. All idle NIL has already been forwarded.
            </p>
          )}
          {isForwardConfirmed && (
            <p className="mt-1 text-xs text-blacklight-success">
              ✓ Stake forwarded successfully.
            </p>
          )}
        </div>

        <div>
          <h4 className="mb-2 text-xs font-semibold text-blacklight-text">
            Settle Epoch
            {unclaimedRewards !== undefined && unclaimedRewards > 0n && (
              <span className="ml-2 font-normal text-blacklight-success">
                ({Number(formatUnits(unclaimedRewards as bigint, NIL_DECIMALS)).toLocaleString(undefined, {
                  maximumFractionDigits: 2,
                })}{" "}
                NIL unclaimed)
              </span>
            )}
          </h4>
          <p className="mb-2 text-xs text-blacklight-text-muted">
            Claim rewards from the reward policy and distribute (platform fee 1%, owner commission, stakers). Callable anytime; no-op if no rewards to claim.
          </p>
          <button
            onClick={handleSettleEpoch}
            disabled={isSettleEpochPending || isSettleEpochConfirming}
            className="btn-secondary"
          >
            {isSettleEpochPending || isSettleEpochConfirming ? "Settling…" : "Settle Epoch"}
          </button>
        </div>

        <div>
          <h4 className="mb-2 text-xs font-semibold text-blacklight-text">
            Process Withdrawal Batch
          </h4>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <label
                htmlFor={`keeper-maxEntries-${poolAddress}`}
                className="mb-1 block text-xs text-blacklight-text-muted"
              >
                Max entries per batch
              </label>
            <input
              id={`keeper-maxEntries-${poolAddress}`}
              type="number"
              min={1}
              max={200}
              value={maxEntries}
              onChange={(e) => setMaxEntries(e.target.value)}
              className="input"
            />
          </div>
          <button
            onClick={handleProcessWithdrawalBatch}
            disabled={
              isProcessBatchPending ||
              isProcessBatchConfirming ||
              (Number(pendingWithdrawalRequestCount ?? 0n) === 0)
            }
            className="btn-secondary whitespace-nowrap"
          >
            {isProcessBatchPending || isProcessBatchConfirming
              ? "Processing…"
              : "Process Withdrawal Batch"}
          </button>
          </div>
          {Number(pendingWithdrawalRequestCount ?? 0n) === 0 && (
            <p className="mt-1 text-xs text-blacklight-text-muted">
              No withdrawal requests pending. Disabled to save gas.
            </p>
          )}
        </div>

        <div>
          <h4 className="mb-2 text-xs font-semibold text-blacklight-text">
            Pull Unstaked From Staking
          </h4>
          <div className="flex flex-col gap-1">
            <button
              onClick={handlePullUnstakedFromStaking}
            disabled={
              isPullUnstakedPending ||
              isPullUnstakedConfirming ||
              !pullable.hasMatured
            }
            className="btn-secondary w-full sm:w-auto"
          >
            {isPullUnstakedPending || isPullUnstakedConfirming
              ? "Pulling…"
              : "Pull Unstaked From Staking"}
          </button>
          {!pullable.hasMatured && (
            <p className="text-xs text-blacklight-text-muted">
              No matured tranches yet. Call only after unbonding delay to save gas.
            </p>
          )}
          {pullable.hasMatured && pullable.amount > 0n && (
            <p className="text-xs text-blacklight-success">
              {Number(formatUnits(pullable.amount, NIL_DECIMALS)).toLocaleString(undefined, {
                maximumFractionDigits: 2,
              })}{" "}
              NIL ready to pull.
            </p>
          )}
          </div>
        </div>

        <div>
          <h4 className="mb-2 text-xs font-semibold text-blacklight-text">
            Process User Withdrawals
          </h4>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <label
                htmlFor={`keeper-user-${poolAddress}`}
                className="mb-1 block text-xs text-blacklight-text-muted"
              >
                User address (claim on behalf)
              </label>
            <input
              id={`keeper-user-${poolAddress}`}
              type="text"
              placeholder="0x..."
              value={userAddress}
              onChange={(e) => setUserAddress(e.target.value)}
              className="input font-mono text-sm"
            />
          </div>
          <button
            onClick={handleProcessUserWithdrawals}
            disabled={
              !isValidUser ||
              isProcessUserPending ||
              isProcessUserConfirming
            }
            className="btn-secondary whitespace-nowrap"
          >
            {isProcessUserPending || isProcessUserConfirming
              ? "Processing…"
              : "Process User Withdrawals"}
          </button>
          </div>
        </div>
      </div>
    </section>
  );
}
