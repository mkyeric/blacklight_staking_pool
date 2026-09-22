/**
 * User-facing labels for the at-node withdrawal wait.
 *
 * After processWithdrawalBatch, unlock time is:
 *   now + StakingOperators.unstakeDelay() + BlacklightPool.WITHDRAWAL_CLAIM_BUFFER
 *
 * Live on Blacklight L2 (queried 2026-09-22): unstakeDelay() = 3600s (1 hour).
 * It was previously 7 days. The pool's claim buffer is still 1 day, so users
 * wait ~25 hours after a batch is processed. Always re-check unstakeDelay()
 * if Nillion changes the protocol delay again.
 */
export const UNBONDING_DURATION_LABEL = "1-hour";
export const PROCESSING_DURATION_LABEL = "1-day";
export const UNLOCK_WAIT_LABEL = "~25-hour";
export const UNLOCK_WAIT_SHORT = "~25 hours";

export const UNLOCK_WAIT_DETAIL = `${UNBONDING_DURATION_LABEL} unbonding + ${PROCESSING_DURATION_LABEL} processing time`;
