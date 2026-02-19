"use client";

/**
 * Warning banner shown when the connected wallet is a pool operator (node wallet).
 * Operator wallets cannot stake — they are reserved for running the Blacklight node.
 */
export function OperatorWalletWarning() {
  return (
    <div className="rounded-xl border-2 border-blacklight-warning bg-blacklight-warning/10 p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-blacklight-warning/20 text-blacklight-warning text-sm font-bold">
          !
        </span>
        <div>
          <p className="text-sm font-semibold text-blacklight-warning">
            Operator wallet detected
          </p>
          <p className="mt-1 text-sm text-blacklight-text-muted">
            This wallet is being used to run a Blacklight node and cannot be
            used for staking. Please switch to a different wallet to deposit or
            withdraw NIL.
          </p>
        </div>
      </div>
    </div>
  );
}
