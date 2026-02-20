/**
 * Contract addresses and ABI imports for the Blacklight Pool dapp.
 *
 * Addresses are public on-chain values (not secrets).
 */

import NILTokenABI from "@/abis/NILToken.json";
import StakingOperatorsABI from "@/abis/StakingOperators.json";

// ---------------------------------------------------------------------------
// NIL Token (ERC-20) on Blacklight L2
// ---------------------------------------------------------------------------
export const NIL_TOKEN_ADDRESS =
  "0x32DEAe728473cb948B4D8661ac0f2755133D4173" as const;

export const nilTokenAbi = NILTokenABI;

// ---------------------------------------------------------------------------
// Staking Operators contract on Blacklight L2
// ---------------------------------------------------------------------------
export const STAKING_OPERATORS_ADDRESS =
  "0x89c1312Cedb0B0F67e4913D2076bd4a860652B69" as const;

export const stakingOperatorsAbi = StakingOperatorsABI;

// NIL token uses 6 decimals on Blacklight L2
export const NIL_DECIMALS = 6;

// Minimum stake required for a Blacklight node to earn rewards
export const MIN_NODE_STAKE = 70_000n * 10n ** 6n; // 70,000 NIL (6 decimals)

// ---------------------------------------------------------------------------
// Pool factory (multi-pool support)
// ---------------------------------------------------------------------------

export const POOL_FACTORY_ADDRESS = (process.env
  .NEXT_PUBLIC_POOL_FACTORY_ADDRESS ?? "") as `0x${string}`;

// Minimal ABI for PoolFactory: PoolCreated events + createPool.
export const poolFactoryAbi = [
  {
    type: "event",
    name: "PoolCreated",
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "owner",
        type: "address",
      },
      {
        indexed: true,
        internalType: "address",
        name: "operator",
        type: "address",
      },
      {
        indexed: false,
        internalType: "address",
        name: "pool",
        type: "address",
      },
    ],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    outputs: [{ name: "", internalType: "address", type: "address" }],
    name: "createPool",
    inputs: [
      { name: "_operator", internalType: "address", type: "address" },
      { name: "_owner", internalType: "address", type: "address" },
      { name: "_commissionBps", internalType: "uint256", type: "uint256" },
      { name: "_minStakePerUser", internalType: "uint256", type: "uint256" },
    ],
  },
] as const;

// Minimal ABI for interacting with BlacklightPool instances from the UI.
export const blacklightPoolAbi = [
  // events (subset used by the UI)
  {
    type: "event",
    anonymous: false,
    name: "EpochSettled",
    inputs: [
      {
        indexed: true,
        internalType: "uint256",
        name: "epochNumber",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "rewardAmount",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "platformFee",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "ownerCommission",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "toStakers",
        type: "uint256",
      },
    ],
  },
  {
    type: "event",
    anonymous: false,
    name: "WithdrawalClaimed",
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "user",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "amount",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "index",
        type: "uint256",
      },
    ],
  },
  // config / views
  {
    type: "function",
    stateMutability: "view",
    outputs: [{ name: "", internalType: "address", type: "address" }],
    name: "owner",
    inputs: [],
  },
  {
    type: "function",
    stateMutability: "view",
    outputs: [{ name: "", internalType: "address", type: "address" }],
    name: "operator",
    inputs: [],
  },
  {
    type: "function",
    stateMutability: "view",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    name: "commissionBps",
    inputs: [],
  },
  {
    type: "function",
    stateMutability: "view",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    name: "minStakePerUser",
    inputs: [],
  },
  {
    type: "function",
    stateMutability: "view",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    name: "totalUserStakes",
    inputs: [],
  },
  {
    type: "function",
    stateMutability: "view",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    name: "stakerCount",
    inputs: [],
  },
  {
    type: "function",
    stateMutability: "view",
    outputs: [{ name: "", internalType: "uint8", type: "uint8" }],
    name: "poolPhase",
    inputs: [],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    outputs: [],
    name: "activateOperator",
    inputs: [{ name: "amountToStake", internalType: "uint256", type: "uint256" }],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    outputs: [],
    name: "forwardStakeToNode",
    inputs: [],
  },
  {
    type: "function",
    stateMutability: "view",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    name: "totalProcessingStake",
    inputs: [],
  },
  {
    // public mapping getter for stakers(address): (processingStake, staked, depositEpoch, depositTimestamp)
    type: "function",
    stateMutability: "view",
    outputs: [
      { name: "processingStake", internalType: "uint256", type: "uint256" },
      { name: "staked", internalType: "uint256", type: "uint256" },
      { name: "depositEpoch", internalType: "uint64", type: "uint64" },
      { name: "depositTimestamp", internalType: "uint64", type: "uint64" },
    ],
    name: "stakers",
    inputs: [
      { name: "", internalType: "address", type: "address" },
    ],
  },
  {
    type: "function",
    stateMutability: "view",
    outputs: [
      { name: "processing", internalType: "uint256", type: "uint256" },
      { name: "atNode", internalType: "uint256", type: "uint256" },
    ],
    name: "getStakerStakeBreakdown",
    inputs: [{ name: "user", internalType: "address", type: "address" }],
  },
  // user actions
  {
    type: "function",
    stateMutability: "nonpayable",
    outputs: [],
    name: "stake",
    inputs: [
      { name: "amount", internalType: "uint256", type: "uint256" },
    ],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    outputs: [],
    name: "withdrawProcessingStake",
    inputs: [{ name: "amount", internalType: "uint256", type: "uint256" }],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    outputs: [],
    name: "requestWithdraw",
    inputs: [
      { name: "amount", internalType: "uint256", type: "uint256" },
    ],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    outputs: [],
    name: "claimWithdrawals",
    inputs: [],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    outputs: [],
    name: "cancelPendingWithdrawal",
    inputs: [{ name: "index", internalType: "uint256", type: "uint256" }],
  },
  // platform fee recipient (view)
  {
    type: "function",
    stateMutability: "view",
    outputs: [{ name: "", internalType: "address", type: "address" }],
    name: "platformFeeRecipient",
    inputs: [],
  },
  {
    type: "function",
    stateMutability: "view",
    outputs: [{ name: "", internalType: "address", type: "address" }],
    name: "rewardPolicy",
    inputs: [],
  },
  // permissionless keeper operations (callable by anyone; UI exposes to platform fee recipient wallet)
  {
    type: "function",
    stateMutability: "view",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    name: "totalPendingWithdrawals",
    inputs: [],
  },
  {
    type: "function",
    stateMutability: "view",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    name: "totalPendingWithdrawalRequestCount",
    inputs: [],
  },
  {
    type: "function",
    stateMutability: "view",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    name: "getPendingWithdrawalRequestCount",
    inputs: [{ name: "user", internalType: "address", type: "address" }],
  },
  {
    type: "function",
    stateMutability: "view",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    name: "getPendingWithdrawalSum",
    inputs: [{ name: "user", internalType: "address", type: "address" }],
  },
  {
    type: "function",
    stateMutability: "view",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    name: "getUnprocessedPendingWithdrawalSum",
    inputs: [{ name: "user", internalType: "address", type: "address" }],
  },
  {
    type: "function",
    stateMutability: "view",
    outputs: [
      {
        name: "",
        internalType: "struct BlacklightPool.WithdrawalRequest[]",
        type: "tuple[]",
        components: [
          { name: "amount", internalType: "uint256", type: "uint256" },
          { name: "requestTimestamp", internalType: "uint64", type: "uint64" },
          { name: "unlockTimestamp", internalType: "uint64", type: "uint64" },
          { name: "claimed", internalType: "bool", type: "bool" },
          { name: "cancelled", internalType: "bool", type: "bool" },
        ],
      },
    ],
    name: "getWithdrawalQueue",
    inputs: [{ name: "user", internalType: "address", type: "address" }],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    outputs: [],
    name: "processWithdrawalBatch",
    inputs: [{ name: "maxEntries", internalType: "uint256", type: "uint256" }],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    outputs: [],
    name: "pullUnstakedFromStaking",
    inputs: [],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    outputs: [],
    name: "processUserWithdrawals",
    inputs: [{ name: "user", internalType: "address", type: "address" }],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    outputs: [],
    name: "settleEpoch",
    inputs: [],
  },
  // Shutdown (Active pools only; 1-day cooling-off; initiator can cancel)
  {
    type: "function",
    stateMutability: "view",
    outputs: [
      { name: "pending", internalType: "bool", type: "bool" },
      { name: "initiatedAt", internalType: "uint64", type: "uint64" },
      { name: "effectiveAt", internalType: "uint64", type: "uint64" },
      { name: "canCancel", internalType: "bool", type: "bool" },
    ],
    name: "getShutdownStatus",
    inputs: [{ name: "caller", internalType: "address", type: "address" }],
  },
  {
    type: "function",
    stateMutability: "view",
    outputs: [{ name: "", internalType: "uint64", type: "uint64" }],
    name: "shutdownInitiatedAt",
    inputs: [],
  },
  {
    type: "function",
    stateMutability: "view",
    outputs: [{ name: "", internalType: "address", type: "address" }],
    name: "shutdownInitiatedBy",
    inputs: [],
  },
  {
    type: "function",
    stateMutability: "view",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    name: "SHUTDOWN_COOLING_OFF_PERIOD",
    inputs: [],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    outputs: [],
    name: "initiateShutdown",
    inputs: [],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    outputs: [],
    name: "initiateShutdownByKeeper",
    inputs: [],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    outputs: [],
    name: "cancelShutdown",
    inputs: [],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    outputs: [],
    name: "confirmShutdown",
    inputs: [],
  },
] as const;

// Minimal ABI for RewardPolicy.rewards(address) to display unclaimed amounts
export const rewardPolicyRewardsAbi = [
  {
    type: "function",
    stateMutability: "view",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    name: "rewards",
    inputs: [{ name: "recipient", internalType: "address", type: "address" }],
  },
] as const;

// PoolPhase enum: 0=Uninitialized, 1=Idle, 2=Active, 3=ShuttingDown
export const POOL_PHASE = {
  Uninitialized: 0,
  Idle: 1,
  Active: 2,
  ShuttingDown: 3,
} as const;
