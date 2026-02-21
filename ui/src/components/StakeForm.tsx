"use client";

import { useState, useEffect } from "react";
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

type StakeFormProps = {
  poolAddress: `0x${string}`;
};

/**
 * Wizard-style "Deposit" flow:
 *  1. Enter amount and validate balance
 *  2. Approve the pool contract to spend the user's NIL (if needed)
 *  3. Deposit NIL into the pool (funds stay in the pool until the operator forwards them to the node)
 */
export function StakeForm({ poolAddress }: StakeFormProps) {
  const { address, isConnected } = useAccount();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState("");
  const [stakingModalOpen, setStakingModalOpen] = useState(false);
  const [justCompleted, setJustCompleted] = useState(false);
  const [stakeErrorMsg, setStakeErrorMsg] = useState<string | null>(null);

  // ---- Read: user's NIL balance ----
  const { data: userBalance, refetch: refetchUserBalance } = useReadContract({
    address: NIL_TOKEN_ADDRESS,
    abi: nilTokenAbi,
    functionName: "balanceOf",
    args: [address!],
    query: { enabled: isConnected && !!address },
  });

  // ---- Read: pool phase (Idle = accumulating; Active = deposit, funds can be forwarded) ----
  const { data: poolPhase } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "poolPhase",
    query: { enabled: !!poolAddress },
  });

  // ---- Read: min stake per user (contract enforces newBalance >= minStakePerUser on stake) ----
  const { data: minStakePerUser } = useReadContract({
    address: poolAddress,
    abi: blacklightPoolAbi,
    functionName: "minStakePerUser",
    query: { enabled: !!poolAddress },
  });

  // ---- Read: current staker balance (processingStake + staked) for min-stake check ----
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

  // ---- Read: current allowance for pool ----
  const { data: currentAllowance, refetch: refetchAllowance } =
    useReadContract({
      address: NIL_TOKEN_ADDRESS,
      abi: nilTokenAbi,
      functionName: "allowance",
      args: [address!, poolAddress],
      query: { enabled: isConnected && !!address && !!poolAddress },
    });

  // Clear "just completed" when user changes amount
  useEffect(() => {
    if (amount && justCompleted) setJustCompleted(false);
  }, [amount, justCompleted]);

  // Clear any prior staking error when user edits the amount
  useEffect(() => {
    if (stakeErrorMsg) setStakeErrorMsg(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount]);

  // ---- Derived values ----
  const parsedAmount = parseDecimalAmount(amount, NIL_DECIMALS);
  const hasEnoughBalance =
    userBalance !== undefined && parsedAmount <= (userBalance as bigint);
  const needsApproval =
    currentAllowance !== undefined &&
    parsedAmount > (currentAllowance as bigint);

  const isValidAmount = parsedAmount > 0n;
  const minStake = minStakePerUser as bigint | undefined;
  const meetsMinStake =
    minStake === undefined
      ? true
      : existingStake + parsedAmount >= minStake;
  const phase = Number(poolPhase);
  const isPoolActive = phase === POOL_PHASE.Active;
  const isPoolShuttingDown = phase === POOL_PHASE.ShuttingDown;
  const canStake = isPoolActive || phase === POOL_PHASE.Idle;
  const stakeLabel = isPoolActive ? "Stake" : "Accumulate NIL";
  // In accumulate stage, do not allow deposit less than min stake per staker
  const isAccumulateStage = !isPoolActive && canStake;
  const depositAmountMeetsMin =
    !isAccumulateStage ||
    minStake === undefined ||
    parsedAmount >= minStake;
  const isPoolConfigured = !!poolAddress;

  function handleOpenStakingModal() {
    if (!isValidAmount || !hasEnoughBalance || !canStake || isPoolShuttingDown || !meetsMinStake || !depositAmountMeetsMin) return;
    setStakeErrorMsg(null);
    setStakingModalOpen(true);
  }

  function handleStakingSuccess() {
    setAmount("");
    setJustCompleted(true);
    refetchUserBalance();
    refetchAllowance();
    queryClient.invalidateQueries({
      predicate: (query) =>
        JSON.stringify(query.queryKey).includes(poolAddress),
    });
  }

  function handleMax() {
    if (userBalance) {
      setAmount(formatUnits(userBalance as bigint, NIL_DECIMALS));
    }
  }

  // ---- UI ----
  if (!isConnected) {
    return (
      <section className="card p-6 text-center">
        <p className="text-blacklight-text-muted">
          Connect your wallet to deposit NIL into this pool.
        </p>
      </section>
    );
  }

  if (!isPoolConfigured) {
    return (
      <section className="card p-6 text-center">
        <p className="text-blacklight-warning">
          No pool selected. Create at least one pool via the Create Pool wizard.
        </p>
      </section>
    );
  }

  return (
    <section className="card p-6">
      <h2 className="mb-4 text-xl font-semibold">Stake</h2>

      {isPoolShuttingDown && (
        <div className="mb-4 rounded-xl border-2 border-blacklight-error bg-blacklight-error/20 p-4">
          <p className="text-sm font-semibold text-blacklight-error">
            Pool is shutting down
          </p>
          <p className="mt-1 text-xs text-blacklight-text-muted">
            New deposits are not allowed. Withdraw your stake via the Withdraw panel.
          </p>
        </div>
      )}

      {/* Step 0: Amount input */}
      <div className="mb-4">
        <label
          htmlFor="stake-amount"
          className="mb-1 block text-sm text-blacklight-text-muted"
        >
          Amount (NIL)
        </label>
        <div className="relative">
          <input
            id="stake-amount"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(sanitizeDecimalInput(e.target.value))}
            className="input pr-16"
          />
          <button
            onClick={handleMax}
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md bg-blacklight-accent-dim px-2 py-1 text-xs font-semibold text-blacklight-accent transition-colors hover:bg-blacklight-accent hover:text-white"
          >
            MAX
          </button>
        </div>
        {userBalance !== undefined && (
          <p className="mt-1 text-xs text-blacklight-text-muted">
            Wallet balance:{" "}
            {Number(formatUnits(userBalance as bigint, NIL_DECIMALS)).toLocaleString(
              undefined,
              { maximumFractionDigits: 4 }
            )}{" "}
            NIL
          </p>
        )}
      </div>

      {isValidAmount && !hasEnoughBalance && (
        <p className="mb-4 text-sm text-blacklight-error">
          Insufficient NIL balance.
        </p>
      )}

      {isValidAmount && hasEnoughBalance && minStake !== undefined && !meetsMinStake && (
        <p className="mb-4 text-sm text-blacklight-error">
          Total stake (current + amount) must be at least{" "}
          {Number(formatUnits(minStake, NIL_DECIMALS)).toLocaleString(undefined, {
            maximumFractionDigits: 2,
          })}{" "}
          NIL (min. per staker).
        </p>
      )}

      {isAccumulateStage && isValidAmount && minStake !== undefined && !depositAmountMeetsMin && (
        <p className="mb-4 text-sm text-blacklight-error">
          In the accumulate stage, deposit amount must be at least{" "}
          {Number(formatUnits(minStake, NIL_DECIMALS)).toLocaleString(undefined, {
            maximumFractionDigits: 2,
          })}{" "}
          NIL (min. per staker).
        </p>
      )}

      {/* Single action: open staking popup (approve + stake grouped) */}
      <div className="flex flex-col gap-3">
        {isValidAmount && hasEnoughBalance && meetsMinStake && depositAmountMeetsMin && canStake && !isPoolShuttingDown && (
          <div className="rounded-xl border border-blacklight-border bg-blacklight-surface/50 p-4">
            <p className="mb-3 text-sm text-blacklight-text-muted">
              {isPoolActive
                ? "Stake NIL into the pool. You'll confirm the required transaction(s) in a popup (approve spending cap if needed, then stake). Your stake stays in the pool until the pool owner forwards it to staking."
                : "Add NIL to the pool. You'll confirm the required transaction(s) in a popup (approve spending cap if needed, then accumulate)."}
            </p>
            <button
              onClick={handleOpenStakingModal}
              className="btn-primary w-full"
            >
              {isPoolActive ? "Stake" : "Accumulate NIL"}
            </button>
          </div>
        )}

        {!isValidAmount && (
          <p className="text-center text-sm text-blacklight-text-muted">
            Enter an amount to continue.
          </p>
        )}

        {stakeErrorMsg && (
          <p className="mt-2 text-xs text-blacklight-error" role="alert">
            {stakeErrorMsg}
          </p>
        )}
      </div>

      {justCompleted && (
        <p className="mt-4 rounded-lg bg-blacklight-success/20 p-3 text-sm text-blacklight-success">
          {isPoolActive
            ? "✓ Deposit complete. Your NIL is in the pool. The operator can later forward it to the node to start earning rewards."
            : "✓ NIL accumulated in the pool. Once the pool reaches 70k and is activated, the operator can forward it to the node."}
        </p>
      )}

      <StakingModal
        open={stakingModalOpen}
        onClose={() => setStakingModalOpen(false)}
        onSuccess={handleStakingSuccess}
        onError={(message) => {
          setStakeErrorMsg(message);
        }}
        poolAddress={poolAddress}
        amount={parsedAmount}
        needsApproval={needsApproval}
        stakeLabel={stakeLabel}
      />
    </section>
  );
}
