"use client";

import { useState, useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { parseUnits, formatUnits, decodeEventLog } from "viem";
import {
  POOL_FACTORY_ADDRESS,
  poolFactoryAbi,
  blacklightPoolAbi,
  STAKING_OPERATORS_ADDRESS,
  stakingOperatorsAbi,
  NIL_TOKEN_ADDRESS,
  NIL_DECIMALS,
  nilTokenAbi,
  MIN_NODE_STAKE,
} from "@/lib/contracts";
import { sanitizePoolName, buildMetadataURI, parsePoolDisplayName } from "@/lib/poolMetadata";
import {
  parseDecimalAmount,
  sanitizeDecimalInput,
} from "@/lib/numberInput";
import { WizardStepper } from "@/components/WizardStepper";
import { StakingModal } from "@/components/StakingModal";
import { useFactoryPools } from "@/hooks/useFactoryPools";

const CREATE_POOL_STEPS = [
  { id: "config", label: "Configure pool" },
  { id: "create", label: "Create pool" },
  { id: "approve", label: "Operator approves staker" },
  { id: "accumulate", label: "Accumulate NIL" },
  { id: "activate", label: "Activate pool" },
  { id: "register", label: "Register operator" },
];

const MIN_STAKE_PER_USER = 500n * 10n ** 6n; // 500 NIL (6 decimals)
const MAX_COMMISSION_BPS = 5000; // 50%

// Inline staking form component for Step 4 — uses StakingModal for grouped approve + stake
function StakeFormInline({
  poolAddress,
  disabled,
  onStakeSuccess,
}: {
  poolAddress: `0x${string}`;
  disabled?: boolean;
  onStakeSuccess?: () => void;
}) {
  const { address, isConnected } = useAccount();
  const [amount, setAmount] = useState("");
  const [stakingModalOpen, setStakingModalOpen] = useState(false);
  const [justCompleted, setJustCompleted] = useState(false);

  const { data: userBalance, refetch: refetchUserBalance } = useReadContract({
    address: NIL_TOKEN_ADDRESS,
    abi: nilTokenAbi,
    functionName: "balanceOf",
    args: [address!],
    query: { enabled: isConnected && !!address },
  });

  const { data: currentAllowance, refetch: refetchAllowance } = useReadContract({
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
  const isValidAmount = parsedAmount > 0n;

  function handleOpenStakingModal() {
    if (!isValidAmount || !hasEnoughBalance || disabled) return;
    setStakingModalOpen(true);
  }

  function handleStakingSuccess() {
    setAmount("");
    setJustCompleted(true);
    refetchUserBalance();
    refetchAllowance();
    onStakeSuccess?.();
  }

  function handleMax() {
    if (userBalance) {
      setAmount(formatUnits(userBalance as bigint, NIL_DECIMALS));
    }
  }

  if (!isConnected) {
    return (
      <p className="text-xs text-blacklight-text-muted">
        Connect your wallet to deposit NIL into this pool.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="stake-amount" className="mb-1 block text-xs text-blacklight-text-muted">
          Amount (NIL)
        </label>
        <div className="relative">
          <input
            id="stake-amount"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => {
              setAmount(sanitizeDecimalInput(e.target.value));
              if (justCompleted) setJustCompleted(false);
            }}
            disabled={disabled}
            className="input pr-16"
          />
          <button
            onClick={handleMax}
            disabled={disabled}
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md bg-blacklight-accent-dim px-2 py-1 text-xs font-semibold text-blacklight-accent transition-colors hover:bg-blacklight-accent hover:text-white disabled:opacity-50"
          >
            MAX
          </button>
        </div>
        {userBalance !== undefined && (
          <p className="mt-1 text-xs text-blacklight-text-muted">
            Balance: {Number(formatUnits(userBalance as bigint, NIL_DECIMALS)).toLocaleString(undefined, { maximumFractionDigits: 2 })} NIL
          </p>
        )}
      </div>

      {isValidAmount && !hasEnoughBalance && (
        <p className="text-xs text-blacklight-error">
          Insufficient NIL balance.
        </p>
      )}

      {isValidAmount && hasEnoughBalance && (
        <button
          onClick={handleOpenStakingModal}
          disabled={disabled}
          className="btn-primary w-full"
        >
          Deposit to pool
        </button>
      )}

      {justCompleted && (
        <p className="text-xs text-blacklight-success">
          ✓ Deposit complete. NIL is in the pool.
        </p>
      )}

      <StakingModal
        open={stakingModalOpen}
        onClose={() => setStakingModalOpen(false)}
        onSuccess={handleStakingSuccess}
        poolAddress={poolAddress}
        amount={parsedAmount}
        needsApproval={needsApproval}
        stakeLabel="Deposit to pool"
      />
    </div>
  );
}

/**
 * Wizard for creating a new staking pool via PoolFactory.
 * Pools must only be created through this flow (factory createPool); creating pools
 * any other way risks front-running of initialize() and wrong owner.
 * Flow: Configure → Create → Operator approveStaker → (Optional) Activate when ≥70k NIL.
 */
export function CreatePoolWizard() {
  const { address, isConnected } = useAccount();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [operatorAddress, setOperatorAddress] = useState("");
  const [commissionBps, setCommissionBps] = useState("500"); // 5%
  const [minStakePerUser, setMinStakePerUser] = useState("500");
  const [createdPoolAddress, setCreatedPoolAddress] = useState<`0x${string}` | null>(null);

  const { pools: allPools } = useFactoryPools();

  const allPoolPhaseContracts = useMemo(
    () =>
      allPools.map((p) => ({
        address: p.pool,
        abi: blacklightPoolAbi,
        functionName: "poolPhase" as const,
      })),
    [allPools]
  );

  const { data: allPoolPhases } = useReadContracts({
    contracts: allPoolPhaseContracts,
    query: { enabled: allPools.length > 0 },
  });

  // Exclude shut-down pools from setup resume/progress in Create Pool tab.
  const resumablePools = useMemo(() => {
    if (!allPoolPhases || allPoolPhases.length !== allPools.length) {
      return allPools;
    }
    return allPools.filter((_, i) => {
      const phase = allPoolPhases[i]?.result;
      return Number(phase) !== 3; // POOL_PHASE.ShuttingDown
    });
  }, [allPools, allPoolPhases]);

  // Only show resumable pools owned by the connected wallet
  const pools = resumablePools.filter(
    (p) => address && p.owner.toLowerCase() === address.toLowerCase()
  );

  // Hydrate from existing pools on reload: if we have no createdPoolAddress but pools exist,
  // allow user to "resume" a pool that still needs setup (approveStaker, etc.)
  const [resumedPoolAddress, setResumedPoolAddress] = useState<`0x${string}` | null>(null);
  const [poolDisplayName, setPoolDisplayName] = useState("");

  const effectivePoolAddress = createdPoolAddress ?? resumedPoolAddress;

  // Read pool owner from contract so we can preserve wizard state when switching to owner
  // (allPools may be stale right after pool creation)
  const { data: poolOwnerFromContract } = useReadContract({
    address: effectivePoolAddress ?? undefined,
    abi: blacklightPoolAbi,
    functionName: "owner",
    query: { enabled: !!effectivePoolAddress },
  });
  const effectivePoolOwner = (poolOwnerFromContract as `0x${string}` | undefined) ?? undefined;

  // When the wallet changes, preserve wizard state if the new wallet is the
  // operator (Steps 3 and 6) or the owner of the current pool (e.g. after
  // approveStaker as operator, user switches back to owner). For any other
  // wallet, clear pool context so auto-resume can re-fire for the new wallet's
  // owned pools (or show a fresh wizard if the wallet has no pools).
  useEffect(() => {
    if (!address) return;
    if (operatorAddress && address.toLowerCase() === operatorAddress.toLowerCase()) {
      return; // operator wallet — keep wizard state
    }
    // Preserve state when switching to the pool owner (e.g. after completing approveStaker as operator)
    if (effectivePoolAddress && address) {
      const isOwnerFromContract =
        poolOwnerFromContract !== undefined &&
        (poolOwnerFromContract as string).toLowerCase() === address.toLowerCase();
      const poolInfo = allPools.find(
        (p) => p.pool.toLowerCase() === effectivePoolAddress.toLowerCase()
      );
      const isOwnerFromList =
        poolInfo && poolInfo.owner.toLowerCase() === address.toLowerCase();
      if (isOwnerFromContract || isOwnerFromList) {
        return; // owner wallet — keep wizard state
      }
      // Don't clear while pool owner is still loading — we might be the owner
      if (poolOwnerFromContract === undefined) return;
    }
    setResumedPoolAddress(null);
    setCreatedPoolAddress(null);
    setStep(0);
    setOperatorAddress("");
    setPoolDisplayName("");
  }, [address, effectivePoolAddress, allPools, poolOwnerFromContract]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-resume when only one owned pool exists (common case after page reload).
  // Only fires for the pool-owner wallet (operator wallet has no owned pools).
  useEffect(() => {
    if (pools.length === 1 && !effectivePoolAddress) {
      const p = pools[0];
      setResumedPoolAddress(p.pool);
      setOperatorAddress(p.operator);
    }
  }, [pools, effectivePoolAddress]);

  // Auto-resume for operator wallet: on page reload with the operator wallet
  // connected, find the pool where this wallet is the operator and resume it
  // so the wizard shows the correct step (e.g. Step 3 or Step 6).
  useEffect(() => {
    if (!address || effectivePoolAddress) return;
    const operatorPool = resumablePools.find(
      (p) => p.operator.toLowerCase() === address.toLowerCase()
    );
    if (operatorPool) {
      setResumedPoolAddress(operatorPool.pool);
      setOperatorAddress(operatorPool.operator);
    }
  }, [resumablePools, address, effectivePoolAddress]);

  const {
    writeContract: writeCreatePool,
    data: createTxHash,
    isPending: isCreating,
  } = useWriteContract();

  const { isLoading: isCreateConfirming, isSuccess: isCreateConfirmed } =
    useWaitForTransactionReceipt({ hash: createTxHash });

  const {
    writeContract: writeApproveStaker,
    data: approveTxHash,
    isPending: isApproving,
  } = useWriteContract();

  const { isLoading: isApproveConfirming, isSuccess: isApproveConfirmed } =
    useWaitForTransactionReceipt({ hash: approveTxHash });

  const {
    writeContract: writeActivate,
    data: activateTxHash,
    isPending: isActivating,
  } = useWriteContract();

  const { isLoading: isActivateConfirming, isSuccess: isActivateConfirmed } =
    useWaitForTransactionReceipt({ hash: activateTxHash });

  const {
    writeContract: writeRegisterOperator,
    data: registerTxHash,
    isPending: isRegistering,
  } = useWriteContract();

  const { isLoading: isRegisterConfirming, isSuccess: isRegisterConfirmed } =
    useWaitForTransactionReceipt({ hash: registerTxHash });

  const {
    writeContract: writeWithdrawProcessing,
    data: withdrawTxHash,
    isPending: isWithdrawing,
  } = useWriteContract();

  const { isLoading: isWithdrawConfirming, isSuccess: isWithdrawConfirmed } =
    useWaitForTransactionReceipt({ hash: withdrawTxHash });

  const publicClient = usePublicClient();

  // When create confirms, parse PoolCreated event to get pool address
  useEffect(() => {
    if (!isCreateConfirmed || !createTxHash || !publicClient) return;
    (async () => {
      try {
        const receipt = await publicClient.getTransactionReceipt({
          hash: createTxHash,
        });
        if (!receipt?.logs) return;
        for (const log of receipt.logs) {
          if (
            POOL_FACTORY_ADDRESS &&
            log.address.toLowerCase() !== POOL_FACTORY_ADDRESS.toLowerCase()
          )
            continue;
          try {
            const decoded = decodeEventLog({
              abi: poolFactoryAbi,
              data: log.data,
              topics: log.topics,
            });
            if (decoded.eventName === "PoolCreated" && decoded.args.pool) {
              setCreatedPoolAddress(decoded.args.pool as `0x${string}`);
              setStep(2);
              break;
            }
          } catch {
            // ignore decode errors
          }
        }
      } catch {
        // ignore
      }
    })();
  }, [isCreateConfirmed, createTxHash, publicClient]);

  // Read pool phase, operator, and idle balance for created/resumed pool
  const { data: poolPhase, refetch: refetchPoolPhase } = useReadContract({
    address: effectivePoolAddress ?? undefined,
    abi: blacklightPoolAbi,
    functionName: "poolPhase",
    query: { enabled: !!effectivePoolAddress },
  });
  const isCurrentPoolShutDown = Number(poolPhase) === 3; // POOL_PHASE.ShuttingDown

  // If the selected/resumed pool is already shut down, clear wizard progress context.
  useEffect(() => {
    if (!effectivePoolAddress || !isCurrentPoolShutDown) return;
    setResumedPoolAddress(null);
    setCreatedPoolAddress(null);
    setStep(0);
    setPoolDisplayName("");
  }, [effectivePoolAddress, isCurrentPoolShutDown]);

  const { data: poolOperatorAddress } = useReadContract({
    address: effectivePoolAddress ?? undefined,
    abi: blacklightPoolAbi,
    functionName: "operator",
    query: { enabled: !!effectivePoolAddress },
  });

  const { data: poolIdleBalance, refetch: refetchPoolIdleBalance } = useReadContract({
    address: NIL_TOKEN_ADDRESS,
    abi: nilTokenAbi,
    functionName: "balanceOf",
    args: [effectivePoolAddress!],
    query: { enabled: !!effectivePoolAddress },
  });

  const { data: userStakerInfo, refetch: refetchUserStakerInfo } = useReadContract({
    address: effectivePoolAddress ?? undefined,
    abi: blacklightPoolAbi,
    functionName: "stakers",
    args: [address!],
    query: { enabled: !!effectivePoolAddress && !!address },
  });
  const { data: ownerStakerInfo } = useReadContract({
    address: effectivePoolAddress ?? undefined,
    abi: blacklightPoolAbi,
    functionName: "stakers",
    args: [effectivePoolOwner!],
    query: { enabled: !!effectivePoolAddress && !!effectivePoolOwner },
  });

  const { data: approvedStaker, refetch: refetchApprovedStaker } = useReadContract({
    address: STAKING_OPERATORS_ADDRESS,
    abi: stakingOperatorsAbi,
    functionName: "approvedStaker",
    args: [operatorAddress as `0x${string}`],
    query: {
      enabled:
        !!operatorAddress &&
        operatorAddress.startsWith("0x") &&
        operatorAddress.length === 42,
    },
  });

  // Check if operator is fresh (no existing stake or prior staker) — required for new pools
  const isOperatorAddressValid =
    !!operatorAddress && operatorAddress.startsWith("0x") && operatorAddress.length === 42;
  const { data: operatorStakeOf } = useReadContract({
    address: STAKING_OPERATORS_ADDRESS,
    abi: stakingOperatorsAbi,
    functionName: "stakeOf",
    args: [operatorAddress as `0x${string}`],
    query: { enabled: isOperatorAddressValid },
  });
  const { data: operatorStaker } = useReadContract({
    address: STAKING_OPERATORS_ADDRESS,
    abi: stakingOperatorsAbi,
    functionName: "operatorStaker",
    args: [operatorAddress as `0x${string}`],
    query: { enabled: isOperatorAddressValid },
  });
  const zeroAddress = "0x0000000000000000000000000000000000000000" as const;
  const isOperatorFresh =
    !isOperatorAddressValid ||
    (operatorStakeOf !== undefined &&
      operatorStaker !== undefined &&
      (operatorStakeOf as bigint) === 0n &&
      ((operatorStaker as string) ?? zeroAddress).toLowerCase() === zeroAddress);

  // Refetch approvedStaker when operator approve tx confirms so UI advances to next step
  useEffect(() => {
    if (isApproveConfirmed) {
      refetchApprovedStaker();
    }
  }, [isApproveConfirmed, refetchApprovedStaker]);

  // Refetch poolPhase when activate tx confirms so UI advances to Register operator step
  useEffect(() => {
    if (isActivateConfirmed) {
      refetchPoolPhase();
    }
  }, [isActivateConfirmed, refetchPoolPhase]);

  const { data: operatorInfo, refetch: refetchOperatorInfo } = useReadContract({
    address: STAKING_OPERATORS_ADDRESS,
    abi: stakingOperatorsAbi,
    functionName: "getOperatorInfo",
    args: [operatorAddress as `0x${string}`],
    query: {
      enabled:
        !!operatorAddress &&
        operatorAddress.startsWith("0x") &&
        operatorAddress.length === 42,
    },
  });

  // Refetch operator info when register tx confirms so UI updates and wizard can transition to done
  useEffect(() => {
    if (isRegisterConfirmed) {
      refetchOperatorInfo();
    }
  }, [isRegisterConfirmed, refetchOperatorInfo]);

  // Refetch pool balance and user staker info when withdraw confirms; invalidate NIL balance so Header and forms update
  useEffect(() => {
    if (isWithdrawConfirmed) {
      refetchPoolIdleBalance();
      refetchUserStakerInfo();
      queryClient.invalidateQueries({
        predicate: (query) =>
          JSON.stringify(query.queryKey).toLowerCase().includes(NIL_TOKEN_ADDRESS.toLowerCase()),
      });
      if (effectivePoolAddress) {
        queryClient.invalidateQueries({
          predicate: (query) =>
            JSON.stringify(query.queryKey).includes(effectivePoolAddress),
        });
      }
    }
  }, [isWithdrawConfirmed, refetchPoolIdleBalance, refetchUserStakerInfo, queryClient, effectivePoolAddress]);

  const isOperatorApproved =
    approvedStaker !== undefined &&
    effectivePoolAddress !== null &&
    (approvedStaker as string).toLowerCase() === effectivePoolAddress.toLowerCase();

  // Extract metadataURI from getOperatorInfo — viem returns struct as object { active, metadataURI }
  const operatorMetadataURI =
    operatorInfo !== undefined &&
    operatorInfo !== null &&
    typeof operatorInfo === "object" &&
    "metadataURI" in operatorInfo &&
    typeof (operatorInfo as { metadataURI?: string }).metadataURI === "string"
      ? ((operatorInfo as { metadataURI: string }).metadataURI)
      : Array.isArray(operatorInfo) && operatorInfo.length >= 2 && typeof operatorInfo[1] === "string"
        ? (operatorInfo[1] as string)
        : "";

  // Check if operator is registered: metadataURI will be non-empty if registered
  const isOperatorRegistered = operatorMetadataURI.length > 0;

  const poolIdleBalanceBigInt = (poolIdleBalance as bigint | undefined) ?? undefined;
  const userStakerTuple = userStakerInfo as readonly [bigint, bigint, bigint, bigint] | undefined;
  const userProcessingStake = userStakerTuple?.[0] ?? 0n;
  const ownerStakerTuple = ownerStakerInfo as readonly [bigint, bigint, bigint, bigint] | undefined;
  const ownerStakeBalance = (ownerStakerTuple?.[0] ?? 0n) + (ownerStakerTuple?.[1] ?? 0n);

  const canActivate =
    effectivePoolAddress &&
    poolPhase === 1 && // Idle = 1
    ownerStakeBalance >= MIN_NODE_STAKE &&
    isOperatorApproved;

  const commissionNum = parseInt(commissionBps, 10);
  const minStakeNum = parseUnits(minStakePerUser || "1000", NIL_DECIMALS);
  const isOperatorSameAsOwner =
    !!address &&
    !!operatorAddress &&
    address.toLowerCase() === operatorAddress.toLowerCase();
  const isConfigValid =
    operatorAddress.startsWith("0x") &&
    operatorAddress.length === 42 &&
    commissionNum >= 0 &&
    commissionNum <= MAX_COMMISSION_BPS &&
    minStakeNum >= MIN_STAKE_PER_USER &&
    isOperatorFresh &&
    !isOperatorSameAsOwner;

  function handleCreatePool() {
    if (!isConfigValid || !address || !POOL_FACTORY_ADDRESS) return;
    writeCreatePool({
      address: POOL_FACTORY_ADDRESS,
      abi: poolFactoryAbi,
      functionName: "createPool",
      args: [
        operatorAddress as `0x${string}`,
        address,
        BigInt(commissionNum),
        minStakeNum,
      ],
    });
  }

  function handleApproveStaker() {
    if (!effectivePoolAddress) return;
    writeApproveStaker({
      address: STAKING_OPERATORS_ADDRESS,
      abi: stakingOperatorsAbi,
      functionName: "approveStaker",
      args: [effectivePoolAddress],
    });
  }

  function handleActivate() {
    if (!effectivePoolAddress || !canActivate) return;
    const amount = poolIdleBalanceBigInt ?? MIN_NODE_STAKE;
    writeActivate({
      address: effectivePoolAddress,
      abi: blacklightPoolAbi,
      functionName: "activateOperator",
      args: [amount],
    });
  }

  function handleRegisterOperator() {
    if (!effectivePoolAddress || !operatorAddress) return;
    const metadataURI = buildMetadataURI(effectivePoolAddress, poolDisplayName);
    writeRegisterOperator({
      address: STAKING_OPERATORS_ADDRESS,
      abi: stakingOperatorsAbi,
      functionName: "registerOperator",
      args: [metadataURI],
    });
  }

  // Check if connected wallet is the operator
  const isConnectedOperator =
    isConnected &&
    address &&
    operatorAddress &&
    address.toLowerCase() === operatorAddress.toLowerCase();

  // Check if operator wallet should be blocked from staking
  const shouldBlockOperatorStaking = isConnectedOperator;

  if (!isConnected) {
    return (
      <section className="card p-6 text-center">
        <p className="text-blacklight-text-muted">
          Connect your wallet to create a pool.
        </p>
      </section>
    );
  }

  if (!POOL_FACTORY_ADDRESS) {
    return (
      <section className="card p-6 text-center">
        <p className="text-blacklight-warning">
          Pool factory address is not configured. Set{" "}
          <code className="rounded bg-blacklight-surface px-1 py-0.5 font-mono text-xs">
            NEXT_PUBLIC_POOL_FACTORY_ADDRESS
          </code>{" "}
          in .env.local.
        </p>
      </section>
    );
  }

  // Pool is "created" if we confirmed the tx OR we resumed from an existing pool.
  // Check against allPools (not owner-filtered) so the wizard still works when
  // the operator wallet is connected for Steps 3 and 6.
  const poolIsCreated =
    !isCurrentPoolShutDown &&
    ((isCreateConfirmed && !!createdPoolAddress) ||
      (!!resumedPoolAddress &&
        resumablePools.some(
          (p) => p.pool.toLowerCase() === resumedPoolAddress.toLowerCase()
        )));

  // Calculate current step based on state.
  // Check poolPhase first: if pool is Active (2), we're past approval/activate, so never show step 2.
  const calculateCurrentStep = () => {
    if (!poolIsCreated || !effectivePoolAddress) {
      return step;
    }

    const ownerBalance = ownerStakeBalance;

    // Pool is Active (phase 2) — already past approval and activation; show Register or Done
    if (poolPhase === 2) {
      return isOperatorRegistered ? 6 : 5;
    }

    // Pool still Idle (phase 1) — may need approval, accumulate, or activate
    if (!isOperatorApproved) {
      return 2;
    }
    if (ownerBalance < MIN_NODE_STAKE) {
      return 3;
    }
    if (ownerBalance >= MIN_NODE_STAKE) {
      return 4;
    }

    return 6;
  };

  const currentStep = calculateCurrentStep();
  const setupComplete = currentStep === 6;

  // When setup is complete (operator registered), show only a compact success state — wizard disappears
  if (setupComplete) {
    const displayName =
      effectivePoolAddress && operatorMetadataURI
        ? parsePoolDisplayName(operatorMetadataURI, effectivePoolAddress)
        : effectivePoolAddress
          ? `${effectivePoolAddress.slice(0, 10)}…${effectivePoolAddress.slice(-8)}`
          : null;
    return (
      <section className="card p-6">
        <div className="rounded-lg bg-blacklight-success/20 p-4 text-center">
          <p className="text-lg font-semibold text-blacklight-success">
            ✓ Pool setup complete
          </p>
          {displayName && (
            <p className="mt-1 text-base font-medium text-blacklight-text">
              {displayName}
            </p>
          )}
          <p className="mt-1 text-sm text-blacklight-text-muted">
            Your pool is fully activated and the operator is registered. The pool can now earn rewards.
          </p>
          {effectivePoolAddress && (
            <p className="mt-2 text-xs font-mono text-blacklight-text-muted">
              {effectivePoolAddress.slice(0, 10)}…{effectivePoolAddress.slice(-8)}
            </p>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="card p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold">Create Pool</h2>
      </div>

      <WizardStepper
        steps={CREATE_POOL_STEPS}
        currentStep={Math.min(currentStep, CREATE_POOL_STEPS.length - 1)}
        completedSteps={
          !poolIsCreated
            ? step > 0
              ? [0]
              : []
            : poolPhase === 2
              ? isOperatorRegistered
                ? [0, 1, 2, 3, 4, 5]
                : [0, 1, 2, 3, 4]
              : isOperatorApproved
                ? canActivate
                  ? isActivateConfirmed
                    ? [0, 1, 2, 3, 4]
                    : [0, 1, 2, 3]
                  : [0, 1, 2]
                : [0, 1, 2]
        }
      />

      {/* Resume setup: when pools exist but we have no pool in context (e.g. after page reload) */}
      {pools.length > 0 && !effectivePoolAddress && (
        <div className="mb-4 rounded-xl border border-blacklight-border bg-blacklight-surface/50 p-4">
          <h3 className="mb-2 text-sm font-semibold">Resume setup</h3>
          <p className="mb-3 text-xs text-blacklight-text-muted">
            You have pools that may need setup. Select a pool to continue where you left off
            (e.g. approve staker, accumulate NIL, activate).
          </p>
          <div className="space-y-2">
            {pools.map((p) => (
              <button
                key={p.pool}
                onClick={() => {
                  setResumedPoolAddress(p.pool);
                  setOperatorAddress(p.operator);
                }}
                className="btn-secondary w-full text-left"
              >
                Resume: Pool {p.pool.slice(0, 10)}… (Operator: {p.operator.slice(0, 10)}…)
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Step 0: Configure */}
      <div className="space-y-4">
        <div className="rounded-lg border border-blacklight-border bg-blacklight-surface/50 p-3">
          <p className="text-xs text-blacklight-text-muted">
            <strong className="text-blacklight-text">Important:</strong> The operator must be a{" "}
            <strong>fresh new operator</strong> — never used before in Nillion&apos;s staking contract.
            A pool cannot be created with an operator that already has stake or has been bound to
            another pool. Use a newly generated node wallet.
          </p>
        </div>
        <div>
          <label htmlFor="operator" className="mb-1 block text-sm text-blacklight-text-muted">
            Operator address (Blacklight node wallet)
          </label>
          <input
            id="operator"
            type="text"
            placeholder="0x..."
            value={operatorAddress}
            onChange={(e) => !poolIsCreated && setOperatorAddress(e.target.value)}
            readOnly={poolIsCreated}
            className={`input ${poolIsCreated ? "cursor-not-allowed bg-blacklight-surface/80 text-blacklight-text-muted" : ""}`}
          />
          {isOperatorAddressValid && !isOperatorFresh && !poolIsCreated && (
            <p className="mt-1 text-xs text-blacklight-error">
              This operator is already in use (has existing stake or is bound to another pool).
              Use a fresh node wallet that has never been used in Nillion&apos;s staking contract.
            </p>
          )}
          {isOperatorAddressValid && isOperatorSameAsOwner && !poolIsCreated && (
            <p className="mt-1 text-xs text-blacklight-error">
              Operator and pool owner cannot be the same address. Connect with the pool owner
              wallet (different from the operator) to create the pool.
            </p>
          )}
        </div>
        <div>
          <label htmlFor="commission" className="mb-1 block text-sm text-blacklight-text-muted">
            Commission (basis points, e.g. 500 = 5%)
          </label>
          <input
            id="commission"
            type="number"
            min={0}
            max={MAX_COMMISSION_BPS}
            value={commissionBps}
            onChange={(e) => !poolIsCreated && setCommissionBps(e.target.value)}
            readOnly={poolIsCreated}
            className={`input ${poolIsCreated ? "cursor-not-allowed bg-blacklight-surface/80 text-blacklight-text-muted" : ""}`}
          />
        </div>
        <div>
          <label htmlFor="minStake" className="mb-1 block text-sm text-blacklight-text-muted">
            Min stake per user (NIL)
          </label>
          <input
            id="minStake"
            type="number"
            min={500}
            value={minStakePerUser}
            onChange={(e) => !poolIsCreated && setMinStakePerUser(e.target.value)}
            readOnly={poolIsCreated}
            className={`input ${poolIsCreated ? "cursor-not-allowed bg-blacklight-surface/80 text-blacklight-text-muted" : ""}`}
          />
        </div>

        {!poolIsCreated && (
          <button
            onClick={() => {
              setStep(1);
              handleCreatePool();
            }}
            disabled={!isConfigValid || isCreating || isCreateConfirming}
            className="btn-primary w-full"
          >
            {isCreating || isCreateConfirming ? "Creating…" : "1. Create Pool"}
          </button>
        )}
      </div>

      {poolIsCreated && (
        <div className="mt-4 space-y-4">
          <p className="rounded-lg bg-blacklight-success/20 p-3 text-sm text-blacklight-success">
            ✓ Pool created! {effectivePoolAddress && `Address: ${effectivePoolAddress.slice(0, 10)}…`}
          </p>

          {/* Step 3: Operator approves staker (required before staking) */}
          {currentStep === 2 && (
            <div className="rounded-xl border border-blacklight-border bg-blacklight-surface/50 p-4">
              <h3 className="mb-2 text-sm font-semibold">Step 3: Operator approves staker</h3>
              <p className="mb-3 text-xs text-blacklight-text-muted">
                The operator (node wallet) must call{" "}
                <code className="rounded bg-blacklight-surface px-1 py-0.5 font-mono text-xs">
                  approveStaker(poolAddress)
                </code>{" "}
                on the StakingOperators contract. <strong>Staking is blocked until this is completed.</strong>
              </p>
              {effectivePoolAddress && (
                <>
                  {isOperatorApproved ? (
                    <p className="text-sm text-blacklight-success">
                      ✓ Pool is approved by operator. You can now proceed to accumulate NIL.
                    </p>
                  ) : isConnectedOperator ? (
                    <div className="space-y-3">
                      <button
                        onClick={handleApproveStaker}
                        disabled={isApproving || isApproveConfirming}
                        className="btn-primary w-full"
                      >
                        {isApproving || isApproveConfirming ? "Approving…" : "Approve Pool as Operator"}
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-sm text-blacklight-warning">
                        ⚠ Please switch to the operator wallet to approve the pool.
                      </p>
                      <p className="text-xs text-blacklight-text-muted">
                        Operator address: <code className="rounded bg-blacklight-surface px-1 py-0.5 font-mono text-xs">{operatorAddress}</code>
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Step 4: Accumulate NIL */}
          {currentStep === 3 && isOperatorApproved && (
            <div className="rounded-xl border border-blacklight-border bg-blacklight-surface/50 p-4">
              <h3 className="mb-2 text-sm font-semibold">Step 4: Accumulate NIL</h3>
              {poolOperatorAddress && (
                <p className="mb-2 text-xs text-blacklight-text-muted">
                  Current Nillion account in pool:{" "}
                  <code className="rounded bg-blacklight-surface px-1 py-0.5 font-mono text-xs">
                    {typeof poolOperatorAddress === "string"
                      ? poolOperatorAddress
                      : String(poolOperatorAddress)}
                  </code>
                </p>
              )}
              <p className="mb-3 text-xs text-blacklight-text-muted">
                Users and pool owner can stake idle NIL into the pool. The pool owner must have at least 70,000 NIL stake balance to activate.
                Current pool owner stake balance:{" "}
                {ownerStakerTuple !== undefined
                  ? `${Number(formatUnits(ownerStakeBalance, NIL_DECIMALS)).toLocaleString(undefined, { maximumFractionDigits: 2 })} NIL`
                  : "Loading…"}
              </p>

              {shouldBlockOperatorStaking ? (
                <div className="rounded-lg bg-blacklight-warning/20 p-3 text-sm text-blacklight-warning">
                  ⚠ Staking is disabled for the operator wallet to prevent accidental staking.
                  Please switch to a different wallet (owner or user) to deposit NIL.
                </div>
              ) : (
                <StakeFormInline
                  poolAddress={effectivePoolAddress!}
                  disabled={!isOperatorApproved}
                  onStakeSuccess={() => {
                    refetchPoolIdleBalance();
                    refetchUserStakerInfo();
                  }}
                />
              )}

              {/* Withdraw form: allow owner/staker to withdraw all processing stake before activating */}
              {(poolIdleBalanceBigInt ?? 0n) > 0n && (
                <div className="mt-4 rounded-lg border border-blacklight-border bg-blacklight-surface/30 p-3">
                  <h4 className="mb-2 text-sm font-medium text-blacklight-text">Withdraw before activating</h4>
                  <p className="mb-2 text-xs text-blacklight-text-muted">
                    You can withdraw your deposited NIL from the pool before proceeding to Step 5 (Activate).
                  </p>
                  {userStakerTuple !== undefined ? (
                    userProcessingStake > 0n ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm text-blacklight-text">
                          Your deposit in pool:{" "}
                          <strong>
                            {Number(formatUnits(userProcessingStake, NIL_DECIMALS)).toLocaleString(undefined, { maximumFractionDigits: 2 })} NIL
                          </strong>
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            if (effectivePoolAddress && userProcessingStake > 0n) {
                              writeWithdrawProcessing({
                                address: effectivePoolAddress,
                                abi: blacklightPoolAbi,
                                functionName: "withdrawProcessingStake",
                                args: [userProcessingStake],
                              });
                            }
                          }}
                          disabled={isWithdrawing || isWithdrawConfirming}
                          className="btn-secondary text-sm"
                        >
                          {isWithdrawing || isWithdrawConfirming ? "Withdrawing…" : "Withdraw all"}
                        </button>
                      </div>
                    ) : (
                      <p className="text-xs text-blacklight-text-muted">
                        You have no deposit in this pool. Connect the wallet that deposited to withdraw.
                      </p>
                    )
                  ) : (
                    <p className="text-xs text-blacklight-text-muted">Loading your balance…</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Show warning if trying to stake without approval */}
          {currentStep === 3 && !isOperatorApproved && (
            <div className="rounded-xl border border-blacklight-error bg-blacklight-error/20 p-4">
              <h3 className="mb-2 text-sm font-semibold text-blacklight-error">Step 4: Accumulate NIL (Blocked)</h3>
              {poolOperatorAddress && (
                <p className="mb-2 text-xs text-blacklight-text-muted">
                  Current Nillion account in pool:{" "}
                  <code className="rounded bg-blacklight-surface px-1 py-0.5 font-mono text-xs">
                    {typeof poolOperatorAddress === "string"
                      ? poolOperatorAddress
                      : String(poolOperatorAddress)}
                  </code>
                </p>
              )}
              <p className="text-sm text-blacklight-error">
                ⚠ Staking is disabled because the operator has not yet approved the pool as a staker.
                Please complete Step 3 first.
              </p>
            </div>
          )}

          {/* Step 5: Activate */}
          {currentStep === 4 && (
            <div className="rounded-xl border border-blacklight-border bg-blacklight-surface/50 p-4">
              <h3 className="mb-2 text-sm font-semibold">Step 5: Activate pool</h3>
              <p className="mb-3 text-xs text-blacklight-text-muted">
                Pool owner has ≥70,000 NIL stake balance ({ownerStakerTuple !== undefined ? `${Number(formatUnits(ownerStakeBalance, NIL_DECIMALS)).toLocaleString(undefined, { maximumFractionDigits: 2 })} NIL` : "Loading…"}) and operator approved.
                Activate to forward pool NIL to the node and start earning rewards.
              </p>
              <button
                onClick={handleActivate}
                disabled={isActivating || isActivateConfirming || !canActivate}
                className="btn-primary w-full"
              >
                {isActivating || isActivateConfirming ? "Activating…" : "Activate Operator"}
              </button>
            </div>
          )}

          {/* Step 6: Register operator — show whenever pool is Active and we're on this step */}
          {currentStep === 5 && (
            <div className="rounded-xl border border-blacklight-border bg-blacklight-surface/50 p-4">
              <h3 className="mb-2 text-sm font-semibold">Step 6: Register operator</h3>
              {isOperatorRegistered ? (
                <div className="space-y-2">
                  <p className="text-sm text-blacklight-success">
                    ✓ Operator is already registered
                  </p>
                  {effectivePoolAddress && operatorMetadataURI && (
                    <p className="text-sm font-medium text-blacklight-text">
                      Pool name: {parsePoolDisplayName(operatorMetadataURI, effectivePoolAddress)}
                    </p>
                  )}
                  <p className="text-xs text-blacklight-text-muted">
                    Operator was registered previously. The pool can now earn rewards. No further action needed.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-blacklight-warning">
                    ⚠ The pool can earn rewards only after the operator registers.
                  </p>
                  {isConnectedOperator ? (
                    <div className="space-y-3">
                      <div>
                        <label htmlFor="pool-display-name" className="mb-1 block text-sm text-blacklight-text-muted">
                          Pool name (optional, max 30 chars, letters, numbers, hyphen, underscore)
                        </label>
                        <input
                          id="pool-display-name"
                          type="text"
                          placeholder="e.g. my-staking-pool"
                          maxLength={30}
                          value={poolDisplayName}
                          onChange={(e) => setPoolDisplayName(sanitizePoolName(e.target.value))}
                          className="input w-full"
                        />
                        <p className="mt-0.5 text-xs text-blacklight-text-muted">
                          {poolDisplayName.length}/30
                        </p>
                      </div>
                      <p className="text-xs text-blacklight-text-muted">
                        Click the button below to register the operator and start earning rewards:
                      </p>
                      <button
                        onClick={handleRegisterOperator}
                        disabled={isRegistering || isRegisterConfirming}
                        className="btn-primary w-full"
                      >
                        {isRegistering || isRegisterConfirming ? "Registering…" : "Register Operator & Start Earning Rewards"}
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-sm text-blacklight-warning">
                        Please connect the operator wallet to register.
                      </p>
                      <p className="text-xs text-blacklight-text-muted">
                        Operator address: <code className="rounded bg-blacklight-surface px-1 py-0.5 font-mono text-xs">{operatorAddress}</code>
                      </p>
                      <p className="text-xs text-blacklight-text-muted">
                        After connecting, click the button to register and start earning rewards.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
