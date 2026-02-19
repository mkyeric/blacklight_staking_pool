# Contract ABIs

ABI files for contracts on the Nillion Blacklight L2. Staking involves the **NIL token** (balances and transfers), the **staking contract** (locking NIL to a node), and the **reward policy** (claiming verifier rewards).

---

## NILToken.json

**Address:** `0x32DEAe728473cb948B4D8661ac0f2755133D4173`  
**Role:** ERC-20 NIL token (Optimism-style bridge-mintable).

- Use for: `balanceOf`, `transfer`, `approve`, `transferFrom` when your pool or users hold/move NIL.
- [Blockscout](https://explorer-blacklight-x9da3b5afc.t.conduit.xyz/address/0x32DEAe728473cb948B4D8661ac0f2755133D4173)

---

## StakingOperators.json

**Address:** `0x89c1312Cedb0B0F67e4913D2076bd4a860652B69`  
**Role:** Staking-to-node contract. Holds staked NIL and assigns it to **operators** (Blacklight node addresses). Only an **approved staker** per operator can call `stakeTo` / `requestUnstake` / `withdrawUnstaked` for that operator.

**Key functions for a pool:**

| Function | Who calls | Purpose |
|----------|------------|--------|
| `stakeTo(operator, amount)` | Approved staker (e.g. your pool) | Stake NIL to an operator. Contract pulls NIL from caller via `transferFrom` (caller must have approved this contract for NIL). |
| `requestUnstake(operator, amount)` | Same staker | Start unbonding; NIL becomes withdrawable after `unstakeDelay`. |
| `withdrawUnstaked(operator)` | Same staker | After delay, withdraw unbonded NIL back to caller. |
| `stakeOf(operator)` | Anyone (view) | Total NIL staked to that operator. |
| `getUnbondingTranches(operator)` | Anyone (view) | Pending unbonding amounts and `releaseTime` for each. |
| `unstakeDelay()` | Anyone (view) | Unbonding delay in seconds. |
| `stakingToken()` | Anyone (view) | Returns the NIL token address. |

**Operator–staker binding (required for your pool):**

- Each operator has at most one **approved staker** address that may call `stakeTo` / `requestUnstake` / `withdrawUnstaked` for that operator.
- **Operator** (node wallet) must call `approveStaker(staker)` to set who can stake to them. For a pool, the operator calls `approveStaker(yourPoolContractAddress)` so that only your pool can stake NIL to that node.
- View current binding:
  - `approvedStaker(operator)` → current approved staker (can be cleared on first `stakeTo`).
  - `operatorStaker(operator)` → the bound staker for that operator (set on first `stakeTo`, persists afterwards).

- [Blockscout](https://explorer-blacklight-x9da3b5afc.t.conduit.xyz/address/0x89c1312Cedb0B0F67e4913D2076bd4a860652B69)

---

## RewardPolicy.json

**Address:** `0x78E0FEBF3B8936f961729328a25dBA88d4Fea86B`  
**Role:** Reward policy contract. Streams NIL rewards to the **approved staker** (e.g. your pool) for verifier work. The pool (as recipient) calls `claim()` to pull claimable rewards into the pool contract.

**Key functions for a pool:**

| Function | Who calls | Purpose |
|----------|------------|--------|
| `claim()` | Pool (or authorized caller) | Transfer currently claimable NIL rewards to the caller (the pool). |
| `rewardToken()` | Anyone (view) | Returns the NIL token (ERC‑20) used for rewards; verify it matches the pool’s NIL. |
| `rewards(account)` | Anyone (view) | Pending reward balance for a given recipient. |

- [Blockscout](https://explorer-blacklight-x9da3b5afc.t.conduit.xyz/address/0x78E0FEBF3B8936f961729328a25dBA88d4Fea86B)

---

## Why these contracts?

1. **NIL token contract** — Holds all NIL balances and enforces ERC-20 (approve/transferFrom). Any move of NIL goes through this contract.
2. **Staking contract** — Holds the *rules* for staking (who can stake to which operator, unbonding delay, slashing, snapshots). It uses the NIL token: when you call `stakeTo`, the staking contract pulls NIL from the caller; staked NIL sits in the staking contract until withdrawn via `withdrawUnstaked`.
3. **Reward policy contract** — Holds and streams NIL rewards for verifier work. The pool (as recipient/approved staker) calls `claim()` to pull rewards into the pool for settlement and distribution to stakers.

Your pool uses all three: **NIL** for user↔pool flows, **StakingOperators** for pool↔node flows, **RewardPolicy** for claiming verifier rewards.
