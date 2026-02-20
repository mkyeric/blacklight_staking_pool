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

function isUserRejectedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("User rejected") || msg.includes("denied");
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
 * Confirmation-style staking modal.
 * Users explicitly complete each step (approve, then stake) in order.
 * The modal has no manual close and closes automatically only after staking confirms.
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

  const [approveInitiated, setApproveInitiated] = useState(false);
  const [stakeInitiated, setStakeInitiated] = useState(false);
  const lastApproveError = useRef<unknown>(null);
  const lastApproveFailure = useRef<unknown>(null);
  const lastStakeError = useRef<unknown>(null);
  const lastStakeFailure = useRef<unknown>(null);

  useEffect(() => {
    if (!open) {
      setApproveInitiated(false);
      setStakeInitiated(false);
      return;
    }
    setApproveInitiated(false);
    setStakeInitiated(false);
    lastApproveError.current = null;
    lastApproveFailure.current = null;
    lastStakeError.current = null;
    lastStakeFailure.current = null;
  }, [open]);

  // Surface any errors (including user rejections) from either step
  useEffect(() => {
    if (!open) return;

    let message: string | null = null;
    const canInspectApproveErrors = approveInitiated;
    const canInspectStakeErrors = stakeInitiated;

    // Only react to *new* errors for this session so we don't immediately
    // close on stale errors when reopening the modal.
    if (
      canInspectApproveErrors &&
      approveError &&
      approveError !== lastApproveError.current
    ) {
      lastApproveError.current = approveError;
      message = formatContractError(approveError);
    } else if (
      canInspectApproveErrors &&
      isApproveFailed &&
      approveFailureReason &&
      approveFailureReason !== lastApproveFailure.current
    ) {
      lastApproveFailure.current = approveFailureReason;
      message = formatContractError(approveFailureReason);
    } else if (
      canInspectApproveErrors &&
      isApproveFailed &&
      !approveFailureReason
    ) {
      message = "Approval transaction failed.";
    }

    if (
      !message &&
      canInspectStakeErrors &&
      stakeError &&
      stakeError !== lastStakeError.current
    ) {
      lastStakeError.current = stakeError;
      message = formatContractError(stakeError);
    } else if (
      !message &&
      canInspectStakeErrors &&
      isStakeFailed &&
      stakeFailureReason &&
      stakeFailureReason !== lastStakeFailure.current
    ) {
      lastStakeFailure.current = stakeFailureReason;
      message = formatContractError(stakeFailureReason);
    } else if (
      !message &&
      canInspectStakeErrors &&
      isStakeFailed &&
      !stakeFailureReason
    ) {
      message = "Staking transaction failed.";
    }

    const rejectedByUser =
      (canInspectApproveErrors &&
        (isUserRejectedError(approveError) ||
          isUserRejectedError(approveFailureReason))) ||
      (canInspectStakeErrors &&
        (isUserRejectedError(stakeError) ||
          isUserRejectedError(stakeFailureReason)));

    if (message) {
      onError?.(message);
      if (rejectedByUser) {
        onClose();
      }
    }
  }, [
    open,
    approveError,
    isApproveFailed,
    approveFailureReason,
    stakeError,
    isStakeFailed,
    stakeFailureReason,
    approveInitiated,
    stakeInitiated,
  ]);

  const step1Done = needsApproval ? isApproveConfirmed : false;
  const step1Required = needsApproval;
  const step1DoneOrSkipped = !step1Required || step1Done;
  const step2Done = isStakeConfirmed;
  const step1Waiting =
    needsApproval && (isApproving || isApproveConfirming);
  const step2Waiting = isStaking || isStakeConfirming;
  const isComplete = step2Done;
  const canCompleteStep2 = step1DoneOrSkipped;

  useEffect(() => {
    if (!open || !isComplete) return;
    onSuccess?.();
    onClose();
  }, [open, isComplete, onSuccess, onClose]);

  function handleCompleteApproval() {
    if (!open || !needsApproval || step1Done || step1Waiting || !amount || !poolAddress) return;
    setApproveInitiated(true);
    writeApprove({
      address: NIL_TOKEN_ADDRESS,
      abi: nilTokenAbi,
      functionName: "approve",
      args: [poolAddress, amount],
    });
  }

  function handleCompleteStake() {
    if (!open || !canCompleteStep2 || step2Done || step2Waiting || !amount || !poolAddress) return;
    setStakeInitiated(true);
    writeStake({
      address: poolAddress,
      abi: blacklightPoolAbi,
      functionName: "stake",
      args: [amount],
    });
  }

  if (!open) return null;

  const step2Label = stakeLabel;
  const step1Status = step1Done
    ? "Confirmed."
    : step1Waiting
      ? "Waiting for wallet..."
      : approveInitiated
        ? "Retry if needed."
        : "Click complete to continue.";
  const step2Status = step2Done
    ? "Confirmed."
    : step2Waiting
      ? "Waiting for wallet..."
      : canCompleteStep2
        ? stakeInitiated
          ? "Retry if needed."
          : "Click complete to continue."
        : "Complete step 1 first.";

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        aria-hidden
      />
      <div
        className="relative w-full max-w-md rounded-2xl border border-blacklight-border bg-blacklight-card p-6 shadow-xl"
        role="dialog"
        aria-labelledby="staking-modal-title"
      >
        <h2 id="staking-modal-title" className="mb-4 text-xl font-bold">
          {isComplete ? "✓ Staking Complete" : "Complete staking steps"}
        </h2>

        <p className="mb-4 text-sm text-blacklight-text-muted">
          Complete each step below in order.
        </p>
        <ol className="mb-6 list-decimal space-y-1 pl-5 text-sm text-blacklight-text-muted">
          {needsApproval && <li>Approve spending cap for NIL tokens</li>}
          <li>{step2Label}</li>
        </ol>

        <div className="mb-2">
          <div className="flex flex-col gap-0">
            {needsApproval && (
              <>
                {/* Step 1: Token Approval */}
                <div className={`flex items-start gap-3 ${step1Done ? "opacity-75" : ""}`}>
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
                    <p className={`font-medium ${step1Done ? "line-through text-blacklight-text-muted" : ""}`}>
                      Token Approval
                    </p>
                    <p className="text-xs text-blacklight-text-muted">
                      {step1Status}
                    </p>
                    {!step1Done && (
                      <button
                        type="button"
                        onClick={handleCompleteApproval}
                        disabled={step1Waiting}
                        className="btn-primary mt-3 px-4 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Complete
                      </button>
                    )}
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
            <div className={`flex items-start gap-3 ${step2Done ? "opacity-75" : ""}`}>
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
                <p className={`font-medium ${step2Done ? "line-through text-blacklight-text-muted" : ""}`}>
                  {step2Label}
                </p>
                <p className="text-xs text-blacklight-text-muted">
                  {step2Status}
                </p>
                {!step2Done && (
                  <button
                    type="button"
                    onClick={handleCompleteStake}
                    disabled={!canCompleteStep2 || step2Waiting}
                    className="btn-primary mt-3 px-4 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Complete
                  </button>
                )}
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
      </div>
    </div>,
    document.body
  );
}
