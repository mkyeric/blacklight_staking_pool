"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { blacklightPoolAbi, POOL_PHASE } from "@/lib/contracts";
import { useBlockTimestamp } from "@/hooks/useBlockTimestamp";

type ShutdownOperationsProps = {
  poolAddress: `0x${string}`;
};

function formatCoolingOffCountdown(effectiveAt: number, nowSeconds: number): string {
  if (nowSeconds >= effectiveAt) return "Cooling-off ended — confirm to shut down";
  const s = effectiveAt - nowSeconds;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `Shutdown in ${d}d ${h}h ${m}m`;
  if (h > 0) return `Shutdown in ${h}h ${m}m`;
  return `Shutdown in ${m}m`;
}

/**
 * Shutdown workflow for Active pools:
 * - Owner: initiate shutdown, cancel during cooling-off (if owner initiated)
 * - Keeper (platform fee recipient): initiate shutdown by keeper, cancel during cooling-off (if keeper initiated)
 * - Anyone: confirm shutdown after cooling-off
 *
 * Shows prominent warning about consequences and cooling-off countdown.
 */
export function ShutdownOperations({ poolAddress }: ShutdownOperationsProps) {
  const { address, isConnected } = useAccount();
  const queryClient = useQueryClient();
  const nowSeconds = useBlockTimestamp();

  const { data: poolPhase } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "poolPhase",
    query: { enabled: !!poolAddress },
  });

  const { data: poolOwner } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "owner",
    query: { enabled: !!poolAddress },
  });

  const { data: platformFeeRecipient } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "platformFeeRecipient",
    query: { enabled: !!poolAddress },
  });

  const { data: shutdownStatus } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "getShutdownStatus",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled: !!poolAddress && !!address },
  });

  const {
    writeContract: writeInitiateShutdown,
    data: initiateTxHash,
    isPending: isInitiatePending,
  } = useWriteContract();

  const {
    writeContract: writeInitiateShutdownByKeeper,
    data: initiateKeeperTxHash,
    isPending: isInitiateKeeperPending,
  } = useWriteContract();

  const {
    writeContract: writeCancelShutdown,
    data: cancelTxHash,
    isPending: isCancelPending,
  } = useWriteContract();

  const {
    writeContract: writeConfirmShutdown,
    data: confirmTxHash,
    isPending: isConfirmPending,
  } = useWriteContract();

  const { isLoading: isInitiateConfirming, isSuccess: isInitiateConfirmed } =
    useWaitForTransactionReceipt({ hash: initiateTxHash });
  const { isLoading: isInitiateKeeperConfirming, isSuccess: isInitiateKeeperConfirmed } =
    useWaitForTransactionReceipt({ hash: initiateKeeperTxHash });
  const { isLoading: isCancelConfirming, isSuccess: isCancelConfirmed } =
    useWaitForTransactionReceipt({ hash: cancelTxHash });
  const { isLoading: isConfirmConfirming, isSuccess: isConfirmConfirmed } =
    useWaitForTransactionReceipt({ hash: confirmTxHash });

  useEffect(() => {
    if (isInitiateConfirmed || isInitiateKeeperConfirmed || isCancelConfirmed || isConfirmConfirmed) {
      queryClient.invalidateQueries({
        predicate: (query) => JSON.stringify(query.queryKey).includes(poolAddress),
      });
    }
  }, [isInitiateConfirmed, isInitiateKeeperConfirmed, isCancelConfirmed, isConfirmConfirmed, queryClient, poolAddress]);

  const phase = Number(poolPhase);
  const isPoolActive = phase === POOL_PHASE.Active;
  const isPoolShuttingDown = phase === POOL_PHASE.ShuttingDown;

  const status = shutdownStatus as readonly [boolean, bigint, bigint, boolean] | undefined;
  const shutdownPending = status?.[0] ?? false;
  const initiatedAt = status?.[1] !== undefined ? Number(status[1]) : 0;
  const effectiveAt = status?.[2] !== undefined ? Number(status[2]) : 0;
  const canCancel = status?.[3] ?? false;

  const coolingOffElapsed = effectiveAt > 0 && nowSeconds >= effectiveAt;

  const isPoolOwner =
    isConnected &&
    !!address &&
    !!poolOwner &&
    address.toLowerCase() === (poolOwner as string).toLowerCase();

  const isKeeper =
    isConnected &&
    !!address &&
    !!platformFeeRecipient &&
    address.toLowerCase() === (platformFeeRecipient as string).toLowerCase();

  const { data: shutdownInitiatedBy } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "shutdownInitiatedBy",
    query: { enabled: !!poolAddress && shutdownPending },
  });

  const initiatedByOwner =
    shutdownInitiatedBy &&
    poolOwner &&
    String(shutdownInitiatedBy).toLowerCase() === String(poolOwner).toLowerCase();

  if (!isPoolActive && !shutdownPending && !isPoolShuttingDown) {
    return null;
  }

  // Only show shutdown section to pool owner and keeper — stakers should not
  // see the shutdown controls or the irreversibility warning.
  if (!isPoolOwner && !isKeeper) {
    return null;
  }

  const handleInitiateShutdown = () => {
    writeInitiateShutdown({
      address: poolAddress,
      abi: blacklightPoolAbi,
      functionName: "initiateShutdown",
      args: [],
    });
  };

  const handleInitiateShutdownByKeeper = () => {
    writeInitiateShutdownByKeeper({
      address: poolAddress,
      abi: blacklightPoolAbi,
      functionName: "initiateShutdownByKeeper",
      args: [],
    });
  };

  const handleCancelShutdown = () => {
    writeCancelShutdown({
      address: poolAddress,
      abi: blacklightPoolAbi,
      functionName: "cancelShutdown",
      args: [],
    });
  };

  const handleConfirmShutdown = () => {
    writeConfirmShutdown({
      address: poolAddress,
      abi: blacklightPoolAbi,
      functionName: "confirmShutdown",
      args: [],
    });
  };

  return (
    <section className="card p-4 border-2 border-blacklight-error/50">
      <h3 className="mb-2 text-sm font-semibold text-blacklight-error">
        Pool Shutdown
      </h3>

      {/* Warning about consequences — always shown when section is visible */}
      <div className="mb-4 rounded-xl border-2 border-blacklight-error/60 bg-blacklight-error/10 p-4">
        <p className="mb-2 text-sm font-semibold text-blacklight-error">
          ⚠️ Important: Shutdown is irreversible
        </p>
        <ul className="mb-2 list-inside list-disc space-y-0.5 text-xs text-blacklight-text-muted">
          <li>Once confirmed, new deposits are blocked permanently.</li>
          <li>The pool enters &quot;Shutting Down&quot; and cannot be reverted.</li>
          <li>Stakers can withdraw: processing stake immediately, staked amounts after ~8 days.</li>
          <li>The 70,000 NIL minimum floor is bypassed — everyone can exit fully.</li>
        </ul>
        <p className="text-xs font-medium text-blacklight-text">
          Ensure you understand these consequences before proceeding.
        </p>
      </div>

      {isPoolShuttingDown && (
        <div className="rounded-lg bg-blacklight-error/20 p-3 text-sm text-blacklight-error">
          <p className="font-semibold">Pool is shutting down</p>
          <p className="mt-1 text-xs text-blacklight-text-muted">
            No new stakes. Stakers can withdraw via the Withdraw panel. Exit is irreversible.
          </p>
        </div>
      )}

      {shutdownPending && !isPoolShuttingDown && (
        <>
          {/* Cooling-off countdown — close to the warning */}
          <div className="mb-4 rounded-lg border border-blacklight-warning bg-blacklight-warning/20 px-3 py-2">
            <p className="text-sm font-medium text-blacklight-warning">
              Cooling-off period
            </p>
            <p className="mt-0.5 text-xs text-blacklight-text-muted">
              {formatCoolingOffCountdown(effectiveAt, nowSeconds)}
            </p>
            <p className="mt-1 text-xs text-blacklight-text-muted">
              {initiatedByOwner
                ? "Initiated by pool owner. Only the owner can cancel during this period."
                : "Initiated by platform keeper. Only the keeper can cancel during this period."}
            </p>
          </div>

          {canCancel && (
            <button
              onClick={handleCancelShutdown}
              disabled={isCancelPending || isCancelConfirming}
              className="btn-secondary mb-3 w-full sm:w-auto"
            >
              {isCancelPending || isCancelConfirming ? "Cancelling…" : "Cancel Shutdown"}
            </button>
          )}

          {coolingOffElapsed && (
            <div className="space-y-2">
              <p className="text-xs text-blacklight-text-muted">
                Cooling-off has ended. Confirm to finalize shutdown.
              </p>
              <button
                onClick={handleConfirmShutdown}
                disabled={isConfirmPending || isConfirmConfirming}
                className="btn-primary w-full border-blacklight-error bg-blacklight-error text-white hover:bg-blacklight-error/90 sm:w-auto"
              >
                {isConfirmPending || isConfirmConfirming
                  ? "Confirming…"
                  : "Confirm Shutdown"}
              </button>
            </div>
          )}
        </>
      )}

      {isPoolActive && !shutdownPending && (
        <div className="space-y-3">
          {isPoolOwner && (
            <button
              onClick={handleInitiateShutdown}
              disabled={isInitiatePending || isInitiateConfirming}
              className="btn-secondary w-full border-blacklight-error/70 text-blacklight-error hover:bg-blacklight-error/10 sm:w-auto"
            >
              {isInitiatePending || isInitiateConfirming
                ? "Initiating…"
                : "Initiate Shutdown (Owner)"}
            </button>
          )}
          {isKeeper && (
            <button
              onClick={handleInitiateShutdownByKeeper}
              disabled={isInitiateKeeperPending || isInitiateKeeperConfirming}
              className="btn-secondary w-full border-blacklight-error/70 text-blacklight-error hover:bg-blacklight-error/10 sm:w-auto"
            >
              {isInitiateKeeperPending || isInitiateKeeperConfirming
                ? "Initiating…"
                : "Initiate Shutdown (Keeper)"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
