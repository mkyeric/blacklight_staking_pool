"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, useReadContract } from "wagmi";
import { formatUnits } from "viem";
import {
  NIL_TOKEN_ADDRESS,
  NIL_DECIMALS,
  nilTokenAbi,
  blacklightPoolAbi,
  POOL_PHASE,
} from "@/lib/contracts";
import { StakingModal } from "@/components/StakingModal";
import {
  parseDecimalAmount,
  sanitizeDecimalInput,
} from "@/lib/numberInput";

export type QuickStakeModalProps = {
  open: boolean;
  onClose: () => void;
  poolAddress: `0x${string}`;
  poolDisplayName?: string;
  /** Called after successful stake; use to e.g. navigate to My Pools and scroll to this pool */
  onStakeSuccess?: (poolAddress: string) => void;
};

/**
 * Compact modal for staking from the pool table: amount input + approve + stake flow.
 */
export function QuickStakeModal({
  open,
  onClose,
  poolAddress,
  poolDisplayName,
  onStakeSuccess,
}: QuickStakeModalProps) {
  const { address, isConnected } = useAccount();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState("");
  const [stakingModalOpen, setStakingModalOpen] = useState(false);

  const { data: userBalance } = useReadContract({
    address: NIL_TOKEN_ADDRESS,
    abi: nilTokenAbi,
    functionName: "balanceOf",
    args: [address!],
    query: { enabled: isConnected && !!address },
  });

  const { data: poolPhase } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "poolPhase",
    query: { enabled: !!poolAddress },
  });

  const { data: minStakePerUser } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "minStakePerUser",
    query: { enabled: !!poolAddress },
  });

  const { data: stakerInfo } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "stakers",
    args: [address!],
    query: { enabled: isConnected && !!address && !!poolAddress },
  });
  const stakerTuple = stakerInfo as
    | readonly [bigint, bigint, bigint, bigint]
    | undefined;
  const existingStake =
    (stakerTuple?.[0] ?? 0n) + (stakerTuple?.[1] ?? 0n);

  const { data: currentAllowance } = useReadContract({
    address: NIL_TOKEN_ADDRESS,
    abi: nilTokenAbi,
    functionName: "allowance",
    args: [address!, poolAddress],
    query: { enabled: isConnected && !!address && !!poolAddress },
  });

  const parsedAmount = parseDecimalAmount(amount, NIL_DECIMALS);
  const hasEnoughBalance =
    userBalance !== undefined && parsedAmount <= (userBalance as bigint);
  const needsApproval =
    currentAllowance !== undefined &&
    parsedAmount > (currentAllowance as bigint);

  const phase = Number(poolPhase);
  const isPoolActive = phase === POOL_PHASE.Active;
  const isPoolShuttingDown = phase === POOL_PHASE.ShuttingDown;
  const canStake = isPoolActive || phase === POOL_PHASE.Idle;
  const isValidAmount = parsedAmount > 0n;
  const minStake = minStakePerUser as bigint | undefined;
  const meetsMinStake =
    minStake === undefined
      ? true
      : existingStake + parsedAmount >= minStake;

  // Reset state when modal closes
  useEffect(() => {
    if (!open) {
      setAmount("");
      setStakingModalOpen(false);
    }
  }, [open]);

  function handleStake() {
    if (!isValidAmount || !hasEnoughBalance || !canStake || isPoolShuttingDown || !meetsMinStake)
      return;
    setStakingModalOpen(true);
  }

  function handleSuccess() {
    setAmount("");
    setStakingModalOpen(false);
    onClose();
    queryClient.invalidateQueries({
      predicate: (q) => JSON.stringify(q.queryKey).includes(poolAddress),
    });
    onStakeSuccess?.(poolAddress);
  }

  if (!open) return null;

  return createPortal(
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          aria-hidden
          onClick={onClose}
        />
        <div
          className="relative w-full max-w-md rounded-2xl border border-blacklight-border bg-blacklight-card p-6 shadow-xl"
          role="dialog"
          aria-labelledby="quick-stake-modal-title"
        >
          <h2 id="quick-stake-modal-title" className="mb-4 text-xl font-bold">
            Stake in {poolDisplayName ?? "Pool"}
          </h2>

          {!isConnected ? (
            <p className="text-sm text-blacklight-text-muted">
              Connect your wallet to stake.
            </p>
          ) : isPoolShuttingDown ? (
            <p className="text-sm text-blacklight-error">
              This pool is shutting down. New stakes are not accepted.
            </p>
          ) : !canStake ? (
            <p className="text-sm text-blacklight-text-muted">
              Pool is not ready for staking.
            </p>
          ) : (
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="quick-stake-amount"
                  className="mb-1 block text-sm text-blacklight-text-muted"
                >
                  Amount (NIL)
                </label>
                <div className="relative">
                  <input
                    id="quick-stake-amount"
                    type="text"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) =>
                      setAmount(sanitizeDecimalInput(e.target.value))
                    }
                    className="input pr-16"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      userBalance &&
                      setAmount(
                        formatUnits(userBalance as bigint, NIL_DECIMALS)
                      )
                    }
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md bg-blacklight-accent-dim px-2 py-1 text-xs font-semibold text-blacklight-accent transition-colors hover:bg-blacklight-accent hover:text-white"
                  >
                    MAX
                  </button>
                </div>
                {userBalance !== undefined && (
                  <p className="mt-1 text-xs text-blacklight-text-muted">
                    Balance:{" "}
                    {Number(
                      formatUnits(userBalance as bigint, NIL_DECIMALS)
                    ).toLocaleString(undefined, { maximumFractionDigits: 4 })}{" "}
                    NIL
                  </p>
                )}
              </div>

              {isValidAmount && !hasEnoughBalance && (
                <p className="text-sm text-blacklight-error">
                  Insufficient balance.
                </p>
              )}

              {isValidAmount && hasEnoughBalance && minStake !== undefined && !meetsMinStake && (
                <p className="text-sm text-blacklight-error">
                  Total stake (current + amount) must be at least{" "}
                  {Number(formatUnits(minStake, NIL_DECIMALS)).toLocaleString(
                    undefined,
                    { maximumFractionDigits: 2 }
                  )}{" "}
                  NIL (min. per staker).
                </p>
              )}

              <p className="text-xs text-blacklight-text-muted">
                After you stake, your NIL will show as processing stake until the pool forwards it
                to the node. You can withdraw from processing stake anytime on the pool page.
              </p>

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="btn-secondary flex-1"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleStake}
                  disabled={
                    !isValidAmount ||
                    !hasEnoughBalance ||
                    isPoolShuttingDown ||
                    !meetsMinStake
                  }
                  className="btn-primary flex-1"
                >
                  Stake
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <StakingModal
        open={stakingModalOpen}
        onClose={() => setStakingModalOpen(false)}
        onSuccess={handleSuccess}
        poolAddress={poolAddress}
        amount={parsedAmount}
        needsApproval={needsApproval}
        stakeLabel={isPoolActive ? "Deposit to pool" : "Accumulate NIL"}
      />
    </>,
    document.body
  );
}
