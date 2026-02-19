"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { NIL_DECIMALS, blacklightPoolAbi } from "@/lib/contracts";
import { formatUnits } from "viem";

type WriteContractFn = (args: {
  address: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args: unknown[];
}) => void;

export type WithdrawModalProps = {
  open: boolean;
  onClose: () => void;
  /** Called after each successful tx for refetch side effects */
  onStepComplete?: () => void;
  poolAddress: `0x${string}`;
  /** Frozen at open - does not change during modal session */
  immediatePortion: bigint;
  unstakePortion: bigint;
  writeWithdrawProcessing: WriteContractFn;
  isWithdrawProcessingPending: boolean;
  isWithdrawProcessingConfirming: boolean;
  isWithdrawProcessingConfirmed: boolean;
  writeRequestWithdraw: WriteContractFn;
  isRequesting: boolean;
  isRequestConfirming: boolean;
  isRequestConfirmed: boolean;
};

/**
 * Confirmation-style dialog for withdrawal. User confirms each transaction
 * one by one; no auto-trigger. Modal stays open; finished steps are crossed out.
 * User can close anytime without performing actions.
 */
export function WithdrawModal({
  open,
  onClose,
  onStepComplete,
  poolAddress,
  immediatePortion,
  unstakePortion,
  writeWithdrawProcessing,
  isWithdrawProcessingPending,
  isWithdrawProcessingConfirming,
  isWithdrawProcessingConfirmed,
  writeRequestWithdraw,
  isRequesting,
  isRequestConfirming,
  isRequestConfirmed,
}: WithdrawModalProps) {
  const [processingInitiated, setProcessingInitiated] = useState(false);
  const [requestInitiated, setRequestInitiated] = useState(false);

  const hasProcessingStep = immediatePortion > 0n;
  const hasUnstakeStep = unstakePortion > 0n;

  // New session when modal opens: reset so we only count txs started THIS open
  useEffect(() => {
    if (open) {
      setProcessingInitiated(false);
      setRequestInitiated(false);
    }
  }, [open]);

  const processingDone =
    hasProcessingStep && processingInitiated && isWithdrawProcessingConfirmed;
  const requestDone =
    hasUnstakeStep && requestInitiated && isRequestConfirmed;

  const canConfirmUnstake =
    hasUnstakeStep && (!hasProcessingStep || processingDone);

  // Notify parent when a step completes (for refetch, etc.)
  useEffect(() => {
    if (!open) return;
    if (processingDone || requestDone) {
      onStepComplete?.();
    }
  }, [open, processingDone, requestDone, onStepComplete]);

  if (!open) return null;

  const processingLabel = `Withdraw from processing stake${
    hasProcessingStep
      ? ` (${Number(
          formatUnits(immediatePortion, NIL_DECIMALS),
        ).toLocaleString(undefined, { maximumFractionDigits: 2 })} NIL)`
      : ""
  }`;

  const unstakeLabel = `Request to unstake${
    hasUnstakeStep
      ? ` (${Number(
          formatUnits(unstakePortion, NIL_DECIMALS),
        ).toLocaleString(undefined, { maximumFractionDigits: 2 })} NIL)`
      : ""
  }`;

  function handleConfirmProcessing() {
    if (!hasProcessingStep || processingInitiated) return;
    setProcessingInitiated(true);
    writeWithdrawProcessing({
      address: poolAddress,
      abi: blacklightPoolAbi,
      functionName: "withdrawProcessingStake",
      args: [immediatePortion],
    });
  }

  function handleConfirmUnstake() {
    if (!hasUnstakeStep || requestInitiated || !canConfirmUnstake) return;
    setRequestInitiated(true);
    writeRequestWithdraw({
      address: poolAddress,
      abi: blacklightPoolAbi,
      functionName: "requestWithdraw",
      args: [unstakePortion],
    });
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        aria-hidden
        onClick={onClose}
      />
      <div
        className="relative w-full max-w-md rounded-2xl border border-blacklight-border bg-blacklight-card p-6 shadow-xl"
        role="dialog"
        aria-labelledby="withdraw-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-2">
          <h2 id="withdraw-modal-title" className="text-xl font-bold">
            Withdraw
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="-m-2 rounded p-2 text-blacklight-text-muted hover:bg-blacklight-surface hover:text-blacklight-text"
            aria-label="Close"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <p className="mb-4 text-sm text-blacklight-text-muted">
          Confirm the following withdrawal action
          {hasProcessingStep && hasUnstakeStep ? "s" : ""} in your wallet. You
          can close this dialog at any time without completing them.
        </p>

        <ol className="space-y-4 text-sm text-blacklight-text">
          {hasProcessingStep && (
            <li
              className={`flex items-start gap-3 ${
                processingDone ? "opacity-75" : ""
              }`}
            >
              <div className="flex flex-shrink-0 items-center justify-center">
                {processingDone ? (
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blacklight-success text-white">
                    ✓
                  </span>
                ) : isWithdrawProcessingPending ||
                  isWithdrawProcessingConfirming ? (
                  <span className="h-5 w-5 animate-spin rounded-full border-2 border-blacklight-accent border-t-transparent" />
                ) : (
                  <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-blacklight-border text-xs font-semibold">
                    1
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p
                  className={`font-medium ${
                    processingDone ? "line-through text-blacklight-text-muted" : ""
                  }`}
                >
                  {processingLabel}
                </p>
                <p className="mt-1 text-xs text-blacklight-text-muted">
                  {processingDone
                    ? "Confirmed."
                    : isWithdrawProcessingPending ||
                        isWithdrawProcessingConfirming
                      ? "Waiting for wallet..."
                      : "Click confirm to create this transaction."}
                </p>
                {!processingDone && (
                  <button
                    type="button"
                    onClick={handleConfirmProcessing}
                    disabled={
                      processingInitiated ||
                      isWithdrawProcessingPending ||
                      isWithdrawProcessingConfirming
                    }
                    className="btn-primary mt-3 px-4 py-1.5 text-xs"
                  >
                    Confirm
                  </button>
                )}
              </div>
            </li>
          )}

          {hasUnstakeStep && (
            <li
              className={`flex items-start gap-3 ${
                requestDone ? "opacity-75" : ""
              }`}
            >
              <div className="flex flex-shrink-0 items-center justify-center">
                {requestDone ? (
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blacklight-success text-white">
                    ✓
                  </span>
                ) : isRequesting || isRequestConfirming ? (
                  <span className="h-5 w-5 animate-spin rounded-full border-2 border-blacklight-accent border-t-transparent" />
                ) : (
                  <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-blacklight-border text-xs font-semibold">
                    {hasProcessingStep ? "2" : "1"}
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p
                  className={`font-medium ${
                    requestDone ? "line-through text-blacklight-text-muted" : ""
                  }`}
                >
                  {unstakeLabel}
                </p>
                <p className="mt-1 text-xs text-blacklight-text-muted">
                  {requestDone
                    ? "Confirmed."
                    : isRequesting || isRequestConfirming
                      ? "Waiting for wallet..."
                      : canConfirmUnstake
                        ? "Click confirm to create this transaction."
                        : "Complete step 1 first."}
                </p>
                {!requestDone && (
                  <button
                    type="button"
                    onClick={handleConfirmUnstake}
                    disabled={
                      !canConfirmUnstake ||
                      requestInitiated ||
                      isRequesting ||
                      isRequestConfirming
                    }
                    className="btn-primary mt-3 px-4 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Confirm
                  </button>
                )}
              </div>
            </li>
          )}
        </ol>

        <button
          type="button"
          onClick={onClose}
          className="btn-secondary mt-6 w-full"
        >
          Close
        </button>
      </div>
    </div>,
    document.body
  );
}
