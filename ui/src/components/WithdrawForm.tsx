"use client";

import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { formatUnits } from "viem";
import {
  NIL_TOKEN_ADDRESS,
  NIL_DECIMALS,
  MIN_NODE_STAKE,
  nilTokenAbi,
  blacklightPoolAbi,
  POOL_PHASE,
} from "@/lib/contracts";
import {
  parseDecimalAmount,
  sanitizeDecimalInput,
} from "@/lib/numberInput";
import { useBlockTimestamp } from "@/hooks/useBlockTimestamp";
import { WithdrawModal } from "@/components/WithdrawModal";

type WithdrawalRequestRow = {
  amount: bigint;
  requestTimestamp: number;
  unlockTimestamp: number;
  claimed: boolean;
  cancelled: boolean;
  /** Index in the contract's withdrawal queue (for cancelPendingWithdrawal). */
  queueIndex?: number;
};

function formatCountdown(unlockTimestamp: number, nowSeconds: number): string {
  if (unlockTimestamp === 0) return "Queued — after processing, ~8-day unbonding starts";
  if (nowSeconds >= unlockTimestamp) return "Claimable";
  const s = unlockTimestamp - nowSeconds;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `Unlocks in ${d}d ${h}h`;
  if (h > 0) return `Unlocks in ${h}h ${m}m`;
  return `Unlocks in ${m}m`;
}

/** Map contract revert / wagmi error to a short user-facing message */
function formatContractError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("OperatorStakeTooLow") || msg.includes("0x8eead6ac"))
    return "Withdrawal would leave the owner below 70,000 NIL minimum. Try a smaller amount.";
  if (msg.includes("InsufficientStake") || msg.includes("0xf1bc94d2"))
    return "Amount exceeds your balance in the pool.";
  if (msg.includes("InsufficientProcessingStake"))
    return "No processing stake (it may have been forwarded already). Try a smaller amount or refresh.";
  if (msg.includes("IdlePhaseUseWithdrawProcessingStake"))
    return "In Idle phase use \"Withdraw from processing\" to withdraw.";
  if (msg.includes("BelowMinimumStake") || msg.includes("0x8ecf3d03"))
    return "Remaining balance would be below the pool's minimum per staker. Either withdraw all or withdraw to an amount ≥ the pool's minimum per staker.";
  if (msg.includes("NothingToClaim") || msg.includes("0x969bf728"))
    return "No withdrawals are ready to claim yet.";
  if (msg.includes("TooManyWithdrawalRequests") || msg.includes("0xbacbc2de"))
    return "Maximum concurrent withdrawal requests reached. Claim matured withdrawals first.";
  if (msg.includes("WithdrawalNotPending"))
    return "This withdrawal can't be cancelled (already processed or claimed).";
  if (msg.includes("User rejected") || msg.includes("denied"))
    return "Transaction was rejected.";
  if (msg.length > 120) return msg.slice(0, 120) + "…";
  return msg;
}

type WithdrawFormProps = {
  poolAddress: `0x${string}`;
};

const MAX_CONCURRENT_WITHDRAWAL_REQUESTS = 5;

/**
 * Withdraw: when pool is Idle, requestWithdraw sends NIL immediately.
 * When Active, each request has its own queue entry and unlock time; claim when ready from the list.
 */
export function WithdrawForm({ poolAddress }: WithdrawFormProps) {
  const { address, isConnected } = useAccount();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState("");
  const [withdrawModalOpen, setWithdrawModalOpen] = useState(false);
  // Snapshot of withdrawal breakdown at modal open - stays stable during session
  const [modalSession, setModalSession] = useState<{
    immediatePortion: bigint;
    unstakePortion: bigint;
  } | null>(null);
  // Avoid closing the modal for stale errors from a previous attempt; only close when error appears during this session
  const hadErrorWhenModalOpenedRef = useRef(false);

  const { data: stakeBreakdown, refetch: refetchStakerInfo } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "getStakerStakeBreakdown",
    args: [address!],
    query: { enabled: isConnected && !!address },
  });

  const { data: poolPhase } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "poolPhase",
    query: { enabled: isConnected },
  });

  const { data: pendingWithdrawalCount } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "getPendingWithdrawalRequestCount",
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

  const { data: withdrawalQueueRaw, refetch: refetchWithdrawalQueue } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "getWithdrawalQueue",
    args: [address!],
    query: { enabled: isConnected && !!address },
  });

  const breakdown = stakeBreakdown as readonly [bigint, bigint] | undefined;
  const processingAmount = breakdown?.[0] ?? 0n;
  const stakedAmount = breakdown?.[1] ?? 0n;
  const totalBalance = processingAmount + stakedAmount;

  const nowSeconds = useBlockTimestamp();

  const { data: poolIdleBalance, refetch: refetchPoolIdleBalance } = useReadContract({
    address: NIL_TOKEN_ADDRESS,
    abi: nilTokenAbi,
    functionName: "balanceOf",
    args: [poolAddress],
  });

  const { data: minStakePerUser } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "minStakePerUser",
    query: { enabled: !!poolAddress },
  });
  const { data: poolOwner } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "owner",
    query: { enabled: !!poolAddress },
  });
  const ownerAddress = poolOwner as `0x${string}` | undefined;
  const { data: ownerStakeInfo } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "stakers",
    args: [ownerAddress!],
    query: { enabled: !!poolAddress && !!ownerAddress },
  });
  const { data: ownerUnprocessedPendingWithdrawalSum } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "getUnprocessedPendingWithdrawalSum",
    args: [ownerAddress!],
    query: { enabled: !!poolAddress && !!ownerAddress },
  });

  const {
    writeContract: writeRequestWithdraw,
    data: requestTxHash,
    isPending: isRequesting,
    error: requestWithdrawError,
  } = useWriteContract();

  const {
    isLoading: isRequestConfirming,
    isSuccess: isRequestConfirmed,
    isError: isRequestFailed,
    failureReason: requestFailureReason,
  } = useWaitForTransactionReceipt({ hash: requestTxHash });

  const {
    writeContract: writeClaim,
    data: claimTxHash,
    isPending: isClaiming,
    error: claimError,
  } = useWriteContract();

  const {
    isLoading: isClaimConfirming,
    isSuccess: isClaimConfirmed,
    isError: isClaimFailed,
    failureReason: claimFailureReason,
  } = useWaitForTransactionReceipt({ hash: claimTxHash });

  const phase = Number(poolPhase);
  const isPoolIdle = phase === POOL_PHASE.Idle;

  const {
    writeContract: writeWithdrawProcessing,
    data: withdrawProcessingTxHash,
    isPending: isWithdrawProcessingPending,
    error: withdrawProcessingError,
  } = useWriteContract();

  const {
    isLoading: isWithdrawProcessingConfirming,
    isSuccess: isWithdrawProcessingConfirmed,
    isError: isWithdrawProcessingFailed,
    failureReason: withdrawProcessingFailureReason,
  } = useWaitForTransactionReceipt({ hash: withdrawProcessingTxHash });

  useEffect(() => {
    if (isRequestConfirmed || isWithdrawProcessingConfirmed) {
      setAmount("");
      // Refetch balances so UI updates immediately after withdrawal (Idle = instant; Active = after claim)
      refetchStakerInfo();
      refetchPoolIdleBalance();
      refetchWithdrawalQueue();
      // Invalidate pool-related queries so PoolCard "TOTAL POOL STAKE" (totalUserStakes) updates
      queryClient.invalidateQueries({
        predicate: (query) =>
          JSON.stringify(query.queryKey).includes(poolAddress),
      });
      // Invalidate NIL token balance queries so wallet balance updates in Header and StakeForm
      // Use case-insensitive match since wagmi may store addresses checksummed
      queryClient.invalidateQueries({
        predicate: (query) =>
          JSON.stringify(query.queryKey).toLowerCase().includes(NIL_TOKEN_ADDRESS.toLowerCase()),
      });
    }
  }, [isRequestConfirmed, isWithdrawProcessingConfirmed, isPoolIdle, refetchStakerInfo, refetchPoolIdleBalance, refetchWithdrawalQueue, queryClient, poolAddress]);

  useEffect(() => {
    if (isClaimConfirmed) {
      setAmount("");
      refetchWithdrawalQueue();
      // Invalidate so PoolCard and other pool stats stay in sync after claim
      queryClient.invalidateQueries({
        predicate: (query) =>
          JSON.stringify(query.queryKey).includes(poolAddress),
      });
      // Invalidate NIL token balance queries so wallet balance updates in Header and StakeForm
      // Use case-insensitive match since wagmi may store addresses checksummed
      queryClient.invalidateQueries({
        predicate: (query) =>
          JSON.stringify(query.queryKey).toLowerCase().includes(NIL_TOKEN_ADDRESS.toLowerCase()),
      });
    }
  }, [isClaimConfirmed, queryClient, poolAddress, refetchWithdrawalQueue]);

  if (!isConnected) {
    return (
      <section className="card p-4 text-center">
        <p className="text-sm text-blacklight-text-muted">
          Connect your wallet to manage withdrawals from this pool.
        </p>
      </section>
    );
  }

  const parsedAmount = parseDecimalAmount(amount, NIL_DECIMALS);
  const hasStake = totalBalance > 0n;
  const hasProcessingStake = processingAmount > 0n;
  const hasStakedAmount = stakedAmount > 0n;
  const isPoolActive = phase === POOL_PHASE.Active;
  const isPoolShuttingDown = phase === POOL_PHASE.ShuttingDown;
  const isPoolActiveOrShuttingDown = isPoolActive || isPoolShuttingDown;
  const pendingCount = Number(pendingWithdrawalCount ?? 0n);
  const atWithdrawalLimit = isPoolActiveOrShuttingDown && pendingCount >= MAX_CONCURRENT_WITHDRAWAL_REQUESTS;
  const minStakeBn = typeof minStakePerUser === "bigint" ? minStakePerUser : undefined;
  const ownerStakeTuple = ownerStakeInfo as readonly [bigint, bigint, bigint, bigint] | undefined;
  const ownerTotalStake = (ownerStakeTuple?.[0] ?? 0n) + (ownerStakeTuple?.[1] ?? 0n);
  const ownerUnprocessedPendingSum =
    typeof ownerUnprocessedPendingWithdrawalSum === "bigint" ? ownerUnprocessedPendingWithdrawalSum : 0n;
  const isConnectedOwner =
    !!address &&
    !!ownerAddress &&
    address.toLowerCase() === ownerAddress.toLowerCase();
  // In ShuttingDown, owner 70k floor is bypassed on-chain; no need to block UI.
  const wouldLeaveOwnerBelow70k =
    isPoolActive &&
    !isPoolShuttingDown &&
    isConnectedOwner &&
    parsedAmount > 0n &&
    parsedAmount <= totalBalance &&
    ownerTotalStake - ownerUnprocessedPendingSum - parsedAmount < MIN_NODE_STAKE;
  // Contract: remaining must be 0 or >= minStakePerUser; withdrawing all (remaining === 0) is allowed
  const remainingAfterWithdraw = parsedAmount > 0n && parsedAmount <= totalBalance ? totalBalance - parsedAmount : 0n;
  const wouldLeaveBelowMinPerStaker =
    minStakeBn !== undefined &&
    parsedAmount > 0n &&
    remainingAfterWithdraw > 0n &&
    remainingAfterWithdraw < minStakeBn;
  const canWithdrawAmount = parsedAmount > 0n && parsedAmount <= totalBalance;
  const amountExceedsBalance = hasStake && parsedAmount > 0n && parsedAmount > totalBalance;
  const immediatePortion =
    canWithdrawAmount
      ? parsedAmount <= processingAmount
        ? parsedAmount
        : processingAmount
      : 0n;
  const unstakePortion =
    canWithdrawAmount && parsedAmount > processingAmount
      ? parsedAmount - immediatePortion
      : 0n;
  const poolIdleBn = typeof poolIdleBalance === "bigint" ? poolIdleBalance : BigInt(0);
  const canClaim = hasStake && poolIdleBn > 0n;

  const requestErrorMsg =
    requestWithdrawError != null
      ? formatContractError(requestWithdrawError)
      : isRequestFailed && requestFailureReason != null
        ? formatContractError(requestFailureReason)
        : isRequestFailed
          ? "Transaction failed. The withdrawal may leave the owner below 70,000 NIL minimum or another rule was not met."
          : null;
  const withdrawProcessingErrorMsg =
    withdrawProcessingError != null
      ? formatContractError(withdrawProcessingError)
      : isWithdrawProcessingFailed && withdrawProcessingFailureReason != null
        ? formatContractError(withdrawProcessingFailureReason)
        : isWithdrawProcessingFailed
          ? "Withdraw from processing failed."
          : null;

  // Normalize getWithdrawalQueue result to WithdrawalRequestRow[] (contract has 5 fields: amount, requestTimestamp, unlockTimestamp, claimed, cancelled)
  const withdrawalRequests: WithdrawalRequestRow[] = (() => {
    const raw = withdrawalQueueRaw;
    if (!raw || !Array.isArray(raw)) return [];
    return raw
      .map((r: unknown, i: number) => {
        const row = r as
          | [bigint, number | bigint, number | bigint, boolean, boolean]
          | { amount: bigint; requestTimestamp: number; unlockTimestamp: number; claimed: boolean; cancelled: boolean };
        const amount = Array.isArray(row) ? row[0] : BigInt(row.amount ?? 0);
        const requestTimestamp = Array.isArray(row) ? Number(row[1]) : Number(row.requestTimestamp ?? 0);
        const unlockTimestamp = Array.isArray(row) ? Number(row[2]) : Number(row.unlockTimestamp ?? 0);
        const claimed = Array.isArray(row) ? Boolean(row[3]) : Boolean(row.claimed ?? false);
        const cancelled = Array.isArray(row) ? Boolean(row[4]) : Boolean(row.cancelled ?? false);
        return { amount, requestTimestamp, unlockTimestamp, claimed, cancelled, queueIndex: i };
      })
      .filter((r) => !r.claimed && !r.cancelled);
  })();

  // A request is claimable only when it's unlocked AND there is enough idle NIL in the pool.
  // We consume idle balance in queue order to mirror how claims are actually serviced.
  let remainingIdleForClaims = poolIdleBn;
  const claimableByLiquidity = new Map<number, boolean>();
  for (const req of withdrawalRequests) {
    const queueIndex = req.queueIndex ?? -1;
    const isUnlocked = req.unlockTimestamp > 0 && req.unlockTimestamp <= nowSeconds && !req.claimed;
    if (!isUnlocked || queueIndex < 0) {
      if (queueIndex >= 0) claimableByLiquidity.set(queueIndex, false);
      continue;
    }
    if (remainingIdleForClaims >= req.amount) {
      claimableByLiquidity.set(queueIndex, true);
      remainingIdleForClaims -= req.amount;
    } else {
      claimableByLiquidity.set(queueIndex, false);
    }
  }

  const hasAnyClaimable = withdrawalRequests.some((r, index) => {
    const queueIndex = r.queueIndex ?? index;
    return claimableByLiquidity.get(queueIndex) === true;
  });

  function handleWithdraw() {
    if (!hasStake || !canWithdrawAmount) return;
    if (unstakePortion > 0n && atWithdrawalLimit) return;
    if (wouldLeaveOwnerBelow70k) return;
    if (wouldLeaveBelowMinPerStaker) return;
    setModalSession({ immediatePortion, unstakePortion });
    setWithdrawModalOpen(true);
  }

  function handleCloseModal() {
    setWithdrawModalOpen(false);
    setModalSession(null);
  }

  // When modal opens, remember if there was already an error (from a previous attempt) so we don't close immediately
  useEffect(() => {
    if (withdrawModalOpen) {
      hadErrorWhenModalOpenedRef.current = !!(
        requestErrorMsg || withdrawProcessingErrorMsg
      );
    }
  }, [withdrawModalOpen]);

  // When error clears while modal is open (e.g. user retries), allow closing again on next error
  useEffect(() => {
    if (withdrawModalOpen && !requestErrorMsg && !withdrawProcessingErrorMsg) {
      hadErrorWhenModalOpenedRef.current = false;
    }
  }, [withdrawModalOpen, requestErrorMsg, withdrawProcessingErrorMsg]);

  // Close the modal only when a *new* withdraw-related error appears during this session (not stale errors from before open)
  useEffect(() => {
    if (!withdrawModalOpen) return;
    const hasError = !!(requestErrorMsg || withdrawProcessingErrorMsg);
    if (hasError && !hadErrorWhenModalOpenedRef.current) {
      setWithdrawModalOpen(false);
      setModalSession(null);
    }
  }, [withdrawModalOpen, requestErrorMsg, withdrawProcessingErrorMsg]);

  return (
    <section className="card p-6">
      <h2 className="mb-4 text-xl font-semibold">Withdraw</h2>

      {isPoolIdle && (
        <p className="mb-3 text-xs text-blacklight-success">
          Pool is inactive — withdrawal is immediate. No waiting period.
        </p>
      )}

      <div className="mb-4">
        <label
          htmlFor={`withdraw-amount-${poolAddress}`}
          className="mb-1 block text-sm text-blacklight-text-muted"
        >
          Amount (NIL)
        </label>
        <input
          id={`withdraw-amount-${poolAddress}`}
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(sanitizeDecimalInput(e.target.value))}
          className="input"
        />
        {hasStake && (
          <p className="mt-1 text-xs text-blacklight-text-muted">
            Processing Stake:{" "}
            {Number(formatUnits(processingAmount, NIL_DECIMALS)).toLocaleString(
              undefined,
              { maximumFractionDigits: 2 }
            )}{" "}
            NIL · Staked (at node):{" "}
            {Number(formatUnits(stakedAmount, NIL_DECIMALS)).toLocaleString(
              undefined,
              { maximumFractionDigits: 2 }
            )}{" "}
            NIL
            {(pendingWithdrawalSum as bigint | undefined) != null &&
              (pendingWithdrawalSum as bigint) > 0n && (
              <>
                {" "}
                · Processing unstake:{" "}
                {Number(
                  formatUnits(pendingWithdrawalSum as bigint, NIL_DECIMALS)
                ).toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
                NIL
              </>
            )}
          </p>
        )}
      </div>

      {!hasStake && (
        <p className="mb-3 text-xs text-blacklight-warning">
          You have no stake in this pool yet.
        </p>
      )}

      {atWithdrawalLimit && (
        <p className="mb-3 text-xs text-blacklight-warning">
          You have reached the maximum of {MAX_CONCURRENT_WITHDRAWAL_REQUESTS} concurrent
          withdrawal requests. Claim matured withdrawals to free quota.
        </p>
      )}

      {wouldLeaveOwnerBelow70k && (
        <p className="mb-3 text-xs text-blacklight-error">
          Withdrawal would leave the owner below 70,000 NIL minimum. Try a smaller amount.
        </p>
      )}

      {wouldLeaveBelowMinPerStaker && minStakeBn !== undefined && (
        <p className="mb-3 text-xs text-blacklight-error">
          Remaining balance would be below the pool's minimum per staker (
          {Number(formatUnits(minStakeBn, NIL_DECIMALS)).toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
          NIL). Either withdraw all or leave at least the minimum per staker.
        </p>
      )}

      {amountExceedsBalance && (
        <p className="mb-3 text-xs text-blacklight-error">
          Amount exceeds your balance in the pool (
          {Number(formatUnits(totalBalance, NIL_DECIMALS)).toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
          NIL). Enter a smaller amount or withdraw all.
        </p>
      )}

      {/* Single action: grouped withdraw (processing first, then unbonding request) */}
      <div className="flex flex-col gap-3">
        {canWithdrawAmount && hasStake && !atWithdrawalLimit && !wouldLeaveOwnerBelow70k && !wouldLeaveBelowMinPerStaker && (
          <div className="rounded-xl border border-blacklight-border bg-blacklight-surface/50 p-4">
            <p className="mb-3 text-sm text-blacklight-text-muted">
              This withdrawal will send{" "}
              <span className="font-mono text-blacklight-text">
                {Number(formatUnits(immediatePortion, NIL_DECIMALS)).toLocaleString(
                  undefined,
                  { maximumFractionDigits: 2 }
                )}{" "}
                NIL
              </span>{" "}
              immediately from processing
              {unstakePortion > 0n && (
                <>
                  {" "}
                  and create an unbonding request for{" "}
                  <span className="font-mono text-blacklight-text">
                    {Number(formatUnits(unstakePortion, NIL_DECIMALS)).toLocaleString(
                      undefined,
                      { maximumFractionDigits: 2 }
                    )}{" "}
                    NIL
                  </span>
                  .
                </>
              )}
            </p>
            <button
              onClick={handleWithdraw}
              disabled={withdrawModalOpen}
              className="btn-primary w-full"
            >
              Withdraw
            </button>
          </div>
        )}

        {(!canWithdrawAmount || !hasStake) && !amountExceedsBalance && (
          <p className="text-center text-sm text-blacklight-text-muted">
            Enter an amount to continue.
          </p>
        )}

        {requestErrorMsg && (
          <p className="mt-2 text-xs text-blacklight-error" role="alert">
            {requestErrorMsg}
          </p>
        )}
        {withdrawProcessingErrorMsg && (
          <p className="mt-2 text-xs text-blacklight-error" role="alert">
            {withdrawProcessingErrorMsg}
          </p>
        )}
      </div>

      <WithdrawModal
        open={withdrawModalOpen}
        onClose={handleCloseModal}
        poolAddress={poolAddress}
        immediatePortion={modalSession?.immediatePortion ?? 0n}
        unstakePortion={modalSession?.unstakePortion ?? 0n}
        writeWithdrawProcessing={writeWithdrawProcessing}
        isWithdrawProcessingPending={isWithdrawProcessingPending}
        isWithdrawProcessingConfirming={isWithdrawProcessingConfirming}
        isWithdrawProcessingConfirmed={isWithdrawProcessingConfirmed}
        writeRequestWithdraw={writeRequestWithdraw}
        isRequesting={isRequesting}
        isRequestConfirming={isRequestConfirming}
        isRequestConfirmed={isRequestConfirmed}
      />

    </section>
  );
}

type UnbondingStakePanelProps = {
  poolAddress: `0x${string}`;
};

/**
 * Shows withdrawal requests that are in the unbonding period and allows users
 * to claim them once ready. Also explains the 5-request limit and ~8-day wait.
 */
export function UnbondingStakePanel({ poolAddress }: UnbondingStakePanelProps) {
  const { address, isConnected } = useAccount();
  const queryClient = useQueryClient();

  const { data: poolPhase } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "poolPhase",
    query: { enabled: isConnected },
  });

  const phase = Number(poolPhase);
  const isPoolIdle = phase === POOL_PHASE.Idle;
  const isPoolActive = phase === POOL_PHASE.Active;
  const isPoolShuttingDown = phase === POOL_PHASE.ShuttingDown;
  const isPoolActiveOrShuttingDown = isPoolActive || isPoolShuttingDown;

  const { data: pendingWithdrawalCount } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "getPendingWithdrawalRequestCount",
    args: [address!],
    query: { enabled: isConnected && !!address },
  });

  const { data: poolIdleBalance } = useReadContract({
    address: NIL_TOKEN_ADDRESS,
    abi: nilTokenAbi,
    functionName: "balanceOf",
    args: [poolAddress],
  });

  const { data: withdrawalQueueRaw, refetch: refetchWithdrawalQueue } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "getWithdrawalQueue",
    args: [address!],
    query: { enabled: isConnected && !!address },
  });

  const [cancellingQueueIndex, setCancellingQueueIndex] = useState<number | null>(null);
  const nowSeconds = useBlockTimestamp();

  const {
    writeContract: writeClaim,
    data: claimTxHash,
    isPending: isClaiming,
    error: claimError,
  } = useWriteContract();

  const {
    isLoading: isClaimConfirming,
    isSuccess: isClaimConfirmed,
    isError: isClaimFailed,
    failureReason: claimFailureReason,
  } = useWaitForTransactionReceipt({ hash: claimTxHash });

  const pendingCount = Number(pendingWithdrawalCount ?? 0n);

  // Normalize getWithdrawalQueue result to WithdrawalRequestRow[] (contract has 5 fields: amount, requestTimestamp, unlockTimestamp, claimed, cancelled)
  const withdrawalRequests: WithdrawalRequestRow[] = (() => {
    const raw = withdrawalQueueRaw;
    if (!raw || !Array.isArray(raw)) return [];
    return raw
      .map((r: unknown, i: number) => {
        const row = r as
          | [bigint, number | bigint, number | bigint, boolean, boolean]
          | { amount: bigint; requestTimestamp: number; unlockTimestamp: number; claimed: boolean; cancelled: boolean };
        const amount = Array.isArray(row) ? row[0] : BigInt(row.amount ?? 0);
        const requestTimestamp = Array.isArray(row) ? Number(row[1]) : Number(row.requestTimestamp ?? 0);
        const unlockTimestamp = Array.isArray(row) ? Number(row[2]) : Number(row.unlockTimestamp ?? 0);
        const claimed = Array.isArray(row) ? Boolean(row[3]) : Boolean(row.claimed ?? false);
        const cancelled = Array.isArray(row) ? Boolean(row[4]) : Boolean(row.cancelled ?? false);
        return { amount, requestTimestamp, unlockTimestamp, claimed, cancelled, queueIndex: i };
      })
      .filter((r) => !r.claimed && !r.cancelled);
  })();

  const poolIdleBn = typeof poolIdleBalance === "bigint" ? poolIdleBalance : 0n;

  // A request is claimable only when it's unlocked AND there is enough idle NIL in the pool.
  // We consume idle balance in queue order to mirror how claims are actually serviced.
  let remainingIdleForClaims = poolIdleBn;
  const claimableByLiquidity = new Map<number, boolean>();
  for (const req of withdrawalRequests) {
    const queueIndex = req.queueIndex ?? -1;
    const isUnlocked = req.unlockTimestamp > 0 && req.unlockTimestamp <= nowSeconds && !req.claimed;
    if (!isUnlocked || queueIndex < 0) {
      if (queueIndex >= 0) claimableByLiquidity.set(queueIndex, false);
      continue;
    }
    if (remainingIdleForClaims >= req.amount) {
      claimableByLiquidity.set(queueIndex, true);
      remainingIdleForClaims -= req.amount;
    } else {
      claimableByLiquidity.set(queueIndex, false);
    }
  }

  const hasAnyClaimable = withdrawalRequests.some((r, index) => {
    const queueIndex = r.queueIndex ?? index;
    return claimableByLiquidity.get(queueIndex) === true;
  });

  const {
    writeContract: writeCancelWithdrawal,
    data: cancelTxHash,
    isPending: isCancelling,
    error: cancelError,
  } = useWriteContract();

  const {
    isLoading: isCancelConfirming,
    isSuccess: isCancelConfirmed,
    isError: isCancelFailed,
    failureReason: cancelFailureReason,
  } = useWaitForTransactionReceipt({ hash: cancelTxHash });

  const claimErrorMsg =
    claimError != null
      ? formatContractError(claimError)
      : isClaimFailed && claimFailureReason != null
        ? formatContractError(claimFailureReason)
        : isClaimFailed
          ? "Claim failed. No withdrawals may be ready to claim yet."
          : null;

  const cancelErrorMsg =
    cancelError != null
      ? formatContractError(cancelError)
      : isCancelFailed && cancelFailureReason != null
        ? formatContractError(cancelFailureReason)
        : isCancelFailed
          ? "Cancel failed. The request may already be processed."
          : null;

  function handleClaim() {
    writeClaim({
      address: poolAddress,
      abi: blacklightPoolAbi,
      functionName: "claimWithdrawals",
      args: [],
    });
  }

  function handleCancel(queueIndex: number) {
    setCancellingQueueIndex(queueIndex);
    writeCancelWithdrawal({
      address: poolAddress,
      abi: blacklightPoolAbi,
      functionName: "cancelPendingWithdrawal",
      args: [BigInt(queueIndex)],
    });
  }

  useEffect(() => {
    if (isClaimConfirmed) {
      refetchWithdrawalQueue();
      // Keep other pool + NIL balances in sync after claim
      queryClient.invalidateQueries({
        predicate: (query) =>
          JSON.stringify(query.queryKey).includes(poolAddress),
      });
      // Use case-insensitive match since wagmi may store addresses checksummed
      queryClient.invalidateQueries({
        predicate: (query) =>
          JSON.stringify(query.queryKey).toLowerCase().includes(NIL_TOKEN_ADDRESS.toLowerCase()),
      });
    }
  }, [isClaimConfirmed, poolAddress, queryClient, refetchWithdrawalQueue]);

  useEffect(() => {
    if (isCancelConfirmed) {
      setCancellingQueueIndex(null);
      refetchWithdrawalQueue();
      queryClient.invalidateQueries({
        predicate: (query) =>
          JSON.stringify(query.queryKey).includes(poolAddress),
      });
    }
  }, [isCancelConfirmed, poolAddress, queryClient, refetchWithdrawalQueue]);

  useEffect(() => {
    if (isCancelFailed) setCancellingQueueIndex(null);
  }, [isCancelFailed]);

  if (!isConnected) {
    return (
      <section className="card p-6 text-center">
        <h2 className="mb-2 text-xl font-semibold">Unbonding Stake</h2>
        <p className="text-xs text-blacklight-text-muted">
          Connect your wallet to view withdrawals that are unbonding from this pool.
        </p>
      </section>
    );
  }

  if (isPoolIdle && withdrawalRequests.length === 0) {
    // In Idle phase there is no unbonding queue; withdrawals are immediate.
    return (
      <section className="card p-6">
        <h2 className="mb-2 text-xl font-semibold">Unbonding Stake</h2>
        <p className="text-xs text-blacklight-text-muted">
          This pool is inactive. Withdrawals are immediate and do not go through an unbonding period.
        </p>
      </section>
    );
  }

  const hasRequests = withdrawalRequests.length > 0;

  return (
    <section className="card p-6">
      <h2 className="mb-2 text-xl font-semibold">Unbonding Stake</h2>
      <p className="mb-2 text-xs text-blacklight-text-muted">
        Withdrawal requests that unstake from the node enter an ~8-day unbonding period
        (7-day unbonding + 1-day processing buffer). You can have up to{" "}
        {MAX_CONCURRENT_WITHDRAWAL_REQUESTS} concurrent requests per pool; current:{" "}
        {pendingCount}/{MAX_CONCURRENT_WITHDRAWAL_REQUESTS}.
      </p>
      {!isPoolActiveOrShuttingDown && !hasRequests && (
        <p className="text-xs text-blacklight-text-muted">
          You currently have no unbonding withdrawals in this pool.
        </p>
      )}
      {hasRequests && (
        <div className="mt-3">
          <h4 className="mb-2 text-xs font-semibold text-blacklight-text-muted">
            Withdrawal requests
          </h4>
          <ul className="space-y-2">
            {withdrawalRequests.map((req, index) => {
              const isUnlocked =
                req.unlockTimestamp > 0 &&
                req.unlockTimestamp <= nowSeconds &&
                !req.claimed;
              const queueIndex = req.queueIndex ?? index;
              const isClaimable = claimableByLiquidity.get(queueIndex) === true;
              const isAwaitingPoolLiquidity = isUnlocked && !isClaimable;
              const isQueued = req.unlockTimestamp === 0;
              return (
                <li
                  key={`${req.requestTimestamp}-${queueIndex}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-blacklight-border bg-blacklight-surface/50 px-3 py-2 text-sm"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium text-blacklight-text">
                      {Number(formatUnits(req.amount, NIL_DECIMALS)).toLocaleString(undefined, {
                        maximumFractionDigits: 2,
                      })}{" "}
                      NIL
                    </span>
                    <span className="text-xs text-blacklight-text-muted">
                      {formatCountdown(req.unlockTimestamp, nowSeconds)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {req.claimed ? (
                      <span className="text-xs text-blacklight-success">Claimed</span>
                    ) : isClaimable ? (
                      <button
                        type="button"
                        onClick={handleClaim}
                        disabled={isClaiming || isClaimConfirming}
                        className="btn-primary px-3 py-1.5 text-xs"
                      >
                        {isClaiming || isClaimConfirming ? "Claiming…" : "Claim"}
                      </button>
                    ) : isAwaitingPoolLiquidity ? (
                      <span className="text-xs text-blacklight-warning">
                        Awaiting pool liquidity
                      </span>
                    ) : isQueued ? (
                      <button
                        type="button"
                        onClick={() => handleCancel(queueIndex)}
                        disabled={isCancelling || isCancelConfirming}
                        className="rounded-lg border border-blacklight-border bg-blacklight-surface px-3 py-1.5 text-xs text-blacklight-text-muted hover:bg-blacklight-border/50 disabled:opacity-50"
                      >
                        {isCancelling || isCancelConfirming
                          ? cancellingQueueIndex === queueIndex
                            ? "Cancelling…"
                            : "Cancel"
                          : "Cancel"}
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {(claimErrorMsg || cancelErrorMsg) && (
        <p className="mt-2 text-xs text-blacklight-error" role="alert">
          {claimErrorMsg ?? cancelErrorMsg}
        </p>
      )}

      {isClaimConfirmed && (
        <p className="mt-2 rounded-lg bg-blacklight-success/20 p-2 text-xs text-blacklight-success">
          ✓ Claim sent. Check your wallet for updated NIL balance.
        </p>
      )}

      {isCancelConfirmed && (
        <p className="mt-2 rounded-lg bg-blacklight-success/20 p-2 text-xs text-blacklight-success">
          ✓ Withdrawal request cancelled. Your stake remains in the pool.
        </p>
      )}
    </section>
  );
}
