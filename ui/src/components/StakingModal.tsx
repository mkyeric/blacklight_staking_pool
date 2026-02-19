 "use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { NIL_TOKEN_ADDRESS, nilTokenAbi, blacklightPoolAbi } from "@/lib/contracts";
import { blacklight } from "@/config/chains";

const EXPLORER_URL = blacklight.blockExplorers?.default?.url ?? "";

function txUrl(hash: `0x${string}`) {
  return `${EXPLORER_URL}/tx/${hash}`;
}

/** Map contract / wallet error to a short user-facing message */
function formatContractError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("User rejected") || msg.includes("denied")) return "Transaction was rejected.";
  if (msg.length > 160) return msg.slice(0, 160) + "…";
  return msg;
}

export type StakingModalProps = {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  /** Called when any step fails or user rejects in wallet */
  onError?: (message: string) => void;
  poolAddress: `0x${string}`;
  amount: bigint;
  needsApproval: boolean;
  stakeLabel?: string;
};

/**
 * Popup that groups the approve + stake flow into a single modal:
 * 1. "Approve spending cap for NIL tokens"
 * 2. "Stake tokens to pool" (or custom stakeLabel)
 * Shows processing status for each step and "Staking Complete" with Continue when done.
 */
export function StakingModal({
  open,
  onClose,
  onSuccess,
  onError,
  poolAddress,
  amount,
  needsApproval,
  stakeLabel = "Stake tokens to pool",
}: StakingModalProps) {
  const {
    writeContract: writeApprove,
    data: approveTxHash,
    isPending: isApproving,
    error: approveError,
  } = useWriteContract();

  const {
    isLoading: isApproveConfirming,
    isSuccess: isApproveConfirmed,
    isError: isApproveFailed,
    failureReason: approveFailureReason,
  } = useWaitForTransactionReceipt({ hash: approveTxHash });

  const {
    writeContract: writeStake,
    data: stakeTxHash,
    isPending: isStaking,
    error: stakeError,
  } = useWriteContract();

  const {
    isLoading: isStakeConfirming,
    isSuccess: isStakeConfirmed,
    isError: isStakeFailed,
    failureReason: stakeFailureReason,
  } = useWaitForTransactionReceipt({ hash: stakeTxHash });

  const hasTriggeredFirstStep = useRef(false);
  const hasAttemptedApprove = useRef(false);
  const hasAttemptedStake = useRef(false);
  const lastApproveError = useRef<unknown>(null);
  const lastApproveFailure = useRef<unknown>(null);
  const lastStakeError = useRef<unknown>(null);
  const lastStakeFailure = useRef<unknown>(null);
  useEffect(() => {
    if (!open) {
      hasTriggeredFirstStep.current = false;
       hasAttemptedApprove.current = false;
       hasAttemptedStake.current = false;
      return;
    }
    if (!amount || !poolAddress || hasTriggeredFirstStep.current) return;
    hasTriggeredFirstStep.current = true;
    if (needsApproval) {
      hasAttemptedApprove.current = true;
      writeApprove({
        address: NIL_TOKEN_ADDRESS,
        abi: nilTokenAbi,
        functionName: "approve",
        args: [poolAddress, amount],
      });
    } else {
      hasAttemptedStake.current = true;
      writeStake({
        address: poolAddress,
        abi: blacklightPoolAbi,
        functionName: "stake",
        args: [amount],
      });
    }
  }, [open, amount, poolAddress, needsApproval, writeApprove, writeStake]);

  // When approve confirms, trigger stake
  useEffect(() => {
    if (!open || !needsApproval || !isApproveConfirmed || !amount || !poolAddress) return;
    hasAttemptedStake.current = true;
    writeStake({
      address: poolAddress,
      abi: blacklightPoolAbi,
      functionName: "stake",
      args: [amount],
    });
  }, [open, needsApproval, isApproveConfirmed, amount, poolAddress]);

  // Surface any errors (including user rejections) from either step
  useEffect(() => {
    if (!open) return;

    // Ignore stale errors from before this modal session
    if (!hasAttemptedApprove.current && !hasAttemptedStake.current) return;

    let message: string | null = null;

    // Only react to *new* errors for this session so we don't immediately
    // close on stale errors when reopening the modal.
    if (approveError && approveError !== lastApproveError.current) {
      lastApproveError.current = approveError;
      message = formatContractError(approveError);
    } else if (
      isApproveFailed &&
      approveFailureReason &&
      approveFailureReason !== lastApproveFailure.current
    ) {
      lastApproveFailure.current = approveFailureReason;
      message = formatContractError(approveFailureReason);
    } else if (isApproveFailed && !approveFailureReason) {
      message = "Approval transaction failed.";
    }

    if (!message && stakeError && stakeError !== lastStakeError.current) {
      lastStakeError.current = stakeError;
      message = formatContractError(stakeError);
    } else if (
      !message &&
      isStakeFailed &&
      stakeFailureReason &&
      stakeFailureReason !== lastStakeFailure.current
    ) {
      lastStakeFailure.current = stakeFailureReason;
      message = formatContractError(stakeFailureReason);
    } else if (!message && isStakeFailed && !stakeFailureReason) {
      message = "Staking transaction failed.";
    }

    if (message) {
      onError?.(message);
      onClose();
    }
  }, [
    open,
    approveError,
    isApproveFailed,
    approveFailureReason,
    stakeError,
    isStakeFailed,
    stakeFailureReason,
  ]);

  const step1Done = needsApproval ? isApproveConfirmed : false;
  const step2Done = isStakeConfirmed;
  const step1Waiting =
    needsApproval && (isApproving || isApproveConfirming);
  const step2Waiting = isStaking || isStakeConfirming;
  const isComplete = step2Done;

  function handleContinue() {
    onSuccess?.();
    onClose();
  }

  if (!open) return null;

  const step2Label = stakeLabel;
  const txCount = needsApproval ? 2 : 1;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        aria-hidden
        onClick={isComplete ? handleContinue : undefined}
      />
      <div
        className="relative w-full max-w-md rounded-2xl border border-blacklight-border bg-blacklight-card p-6 shadow-xl"
        role="dialog"
        aria-labelledby="staking-modal-title"
      >
        <h2 id="staking-modal-title" className="mb-4 text-xl font-bold">
          {isComplete ? "✓ Staking Complete" : "Staking in Progress"}
        </h2>

        <p className="mb-4 text-sm text-blacklight-text-muted">
          You&apos;ll be asked to confirm{" "}
          <strong>
            {txCount} transaction{txCount === 2 ? "s" : ""}
          </strong>
          :
        </p>
        <ol className="mb-6 list-decimal space-y-1 pl-5 text-sm text-blacklight-text-muted">
          {needsApproval && <li>Approve spending cap for NIL tokens</li>}
          <li>{step2Label}</li>
        </ol>

        {!isComplete ? (
          <div className="mb-6">
            <p className="mb-3 font-semibold">Processing...</p>
            <div className="flex flex-col gap-0">
              {needsApproval && (
                <>
                  {/* Step 1: Token Approval */}
                  <div className="flex items-start gap-3">
                    <div className="flex flex-shrink-0 items-center justify-center">
                      {step1Done ? (
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blacklight-success text-white">
                          ✓
                        </span>
                      ) : step1Waiting ? (
                        <span className="h-5 w-5 animate-spin rounded-full border-2 border-blacklight-accent border-t-transparent" />
                      ) : (
                        <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-blacklight-border text-xs font-semibold">
                          1
                        </span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">Token Approval</p>
                      <p className="text-xs text-blacklight-text-muted">
                        {step1Done
                          ? "Confirmed."
                          : step1Waiting
                            ? "Waiting for wallet..."
                            : "Pending"}
                      </p>
                      {approveTxHash && step1Done && (
                        <>
                          <p className="mt-1 truncate font-mono text-xs text-blacklight-accent">
                            {approveTxHash.slice(0, 10)}...{approveTxHash.slice(-8)}
                          </p>
                          <a
                            href={txUrl(approveTxHash)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-0.5 inline-block text-xs font-semibold text-blacklight-accent hover:underline"
                          >
                            View →
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="ml-[11px] h-4 w-0.5 bg-blacklight-border" />
                </>
              )}

              {/* Step 2: Stake Tokens */}
              <div className="flex items-start gap-3">
                <div className="flex flex-shrink-0 items-center justify-center">
                  {step2Done ? (
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blacklight-success text-white">
                      ✓
                    </span>
                  ) : step2Waiting ? (
                    <span className="h-5 w-5 animate-spin rounded-full border-2 border-blacklight-accent border-t-transparent" />
                  ) : (
                    <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-blacklight-border text-xs font-semibold">
                      {needsApproval ? "2" : "1"}
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{step2Label}</p>
                  <p className="text-xs text-blacklight-text-muted">
                    {step2Done
                      ? "Confirmed."
                      : step2Waiting
                        ? "Waiting for wallet..."
                        : "Waiting for approval..."}
                  </p>
                  {stakeTxHash && step2Done && (
                    <>
                      <p className="mt-1 truncate font-mono text-xs text-blacklight-accent">
                        {stakeTxHash.slice(0, 10)}...{stakeTxHash.slice(-8)}
                      </p>
                      <a
                        href={txUrl(stakeTxHash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-0.5 inline-block text-xs font-semibold text-blacklight-accent hover:underline"
                      >
                        View →
                      </a>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="mb-6">
            <p className="mb-3 font-semibold">✓ Complete</p>
            <div className="flex flex-col gap-0">
              {needsApproval && (
                <>
                  <div className="flex items-start gap-3">
                    <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-blacklight-success text-white">
                      ✓
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">Token Approval</p>
                      <p className="text-xs text-blacklight-text-muted">Confirmed</p>
                      {approveTxHash && (
                        <>
                          <p className="mt-1 truncate font-mono text-xs text-blacklight-accent">
                            {approveTxHash.slice(0, 10)}...{approveTxHash.slice(-8)}
                          </p>
                          <a
                            href={txUrl(approveTxHash)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-0.5 inline-block text-xs font-semibold text-blacklight-accent hover:underline"
                          >
                            View →
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="ml-[11px] h-4 w-0.5 bg-blacklight-border" />
                </>
              )}
              <div className="flex items-start gap-3">
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-blacklight-success text-white">
                  ✓
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{step2Label}</p>
                  <p className="text-xs text-blacklight-text-muted">Confirmed</p>
                  {stakeTxHash && (
                    <>
                      <p className="mt-1 truncate font-mono text-xs text-blacklight-accent">
                        {stakeTxHash.slice(0, 10)}...{stakeTxHash.slice(-8)}
                      </p>
                      <a
                        href={txUrl(stakeTxHash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-0.5 inline-block text-xs font-semibold text-blacklight-accent hover:underline"
                      >
                        View →
                      </a>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {isComplete && (
          <button
            type="button"
            onClick={handleContinue}
            className="btn-primary w-full"
          >
            Continue
          </button>
        )}
      </div>
    </div>,
    document.body
  );
}
