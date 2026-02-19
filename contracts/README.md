# Blacklight Pool — Smart Contracts

Solidity contracts for the Blacklight staking pool, built with [Foundry](https://book.getfoundry.sh/).

## Contracts

| Contract | Path | Description |
|----------|------|-------------|
| `BlacklightPool` | `src/BlacklightPool.sol` | Non-custodial staking pool that aggregates user NIL to meet the 70k minimum; enforces min/max per-user stake, a withdrawal queue, reward settlement, and a controlled shutdown flow with cooling-off + explicit `confirmShutdown()` into `ShuttingDown`. |
| `PoolFactory` | `src/PoolFactory.sol` | Deploys a single `BlacklightPool` implementation and creates new pools as minimal proxies (clones). Clone + `initialize()` happen in the same transaction for safety. |
| `IStakingOperators` | `src/interfaces/IStakingOperators.sol` | Interface for Nillion’s on-chain staking-to-node contract (stakeTo / requestUnstake / withdrawUnstaked, `approvedStaker`, `operatorStaker`, `unstakeDelay`, etc.). |
| `IRewardPolicy` | `src/interfaces/IRewardPolicy.sol` | Minimal interface for the reward policy used by Blacklight verifier nodes (`rewardToken`, `rewards`, `claim`). |

### Architecture (high level)

- **One operator = one pool**: Each pool is bound to a single Blacklight node wallet (`operator`).
- **Non-custodial**:
  - NIL moves via ERC‑20 `transferFrom` into the pool, then via `stakeTo` into the staking contract.
  - Withdrawals are always user-initiated and flow back to the user.
- **Phases**:
  - `Uninitialized` → `Idle` (after `initialize`) → `Active` (after `activateOperator`) → `ShuttingDown` (after `confirmShutdown`).
  - In `ShuttingDown`, new stakes are blocked and the 70k operator floor is **bypassed** so everyone can exit.
- **Limits and invariants**:
  - Min per-user stake \(MIN_STAKE_PER_USER = 500 NIL\), adjustable up by owner.
  - Max 100 stakers / pool, max 100,000 NIL per staker.
  - Owner must keep at least 70,000 NIL staked at the node while the pool is `Active` (70k floor).
- **Reward distribution** (`settleEpoch`):
  - Pool calls `rewardPolicy.claim()` and immediately distributes:
    - 1% **platform fee** to `platformFeeRecipient` (hard-coded 100 bps).
    - Owner commission (configurable, max 50% of remaining rewards).
    - Remainder to stakers, pro‑rata by at-node stake (`staked`), with rounding remainder to owner.

### Pool creation and security model

- **Pools must only be created via `PoolFactory.createPool()`**.
  - `BlacklightPool.initialize()` has **no access control**; the first caller sets `owner` and `operator`.
  - If someone deploys or clones `BlacklightPool` and calls `initialize()` directly, they can front‑run and become the owner / commission recipient.
  - `PoolFactory.createPool()` deploys a clone and calls `initialize()` in the **same transaction**, so there is no public front‑running window.
- `PoolFactory` also:
  - Deploys the shared implementation with chain‑wide immutables (NIL token, staking contract, reward policy, platform fee recipient).
  - Enforces `operator != owner` when creating a pool.

### Typical lifecycle

1. **Deploy `PoolFactory`**
   - Use the Foundry script `script/Deploy.s.sol:DeployBlacklightPool` (see Deploy section below).
   - Script wires in NIL token, `StakingOperators`, `RewardPolicy`, and `platformFeeRecipient`.
2. **Create a pool for a node**
   - Call `factory.createPool(operator, owner, commissionBps, minStakePerUser)`.
   - `operator`: node wallet; must be **fresh** (no existing stake and no bound staker).
   - `owner`: pool owner; receives commission and manages the pool.
3. **Bind operator → pool**
   - Operator wallet calls `staking.approveStaker(poolAddress)`.
   - This sets the pool as the only address allowed to call `stakeTo` / `requestUnstake` / `withdrawUnstaked` for that operator.
4. **Fund and activate**
   - Users (not the operator) call `stake(amount)` into the pool; deposits start as **processing stake**.
   - Owner calls `activateOperator(amountToStake)` once enough idle NIL is in the pool (≥ 70,000 NIL and ≥ `amountToStake`).
   - `activateOperator` forwards that amount to the staking contract and transitions pool → `Active`.
5. **Ongoing operation**
   - Users keep staking (subject to per-user min/max and global caps).
   - Anyone may:
     - Call `forwardStakeToNode()` to push processing stake to the node.
     - Call `settleEpoch()` to claim and distribute rewards.
     - Run withdrawal maintenance via `processWithdrawalBatch` / `pullUnstakedFromStaking` / `processUserWithdrawals`.
6. **Shutdown**
   - Owner or platform keeper (platform fee recipient) calls `initiateShutdown()` / `initiateShutdownByKeeper()`.
   - Pool stays `Active` during the cooling‑off period; staking is still allowed and 70k floor enforced.
   - After `SHUTDOWN_COOLING_OFF_PERIOD`, anyone can call `confirmShutdown()` → pool enters `ShuttingDown`:
     - New stakes are blocked.
     - 70k floor is removed so everyone can exit via the withdrawal queue.

## Setup

### Prerequisites

- **Foundry**: install via the [Foundry book](https://book.getfoundry.sh/getting-started/installation).
- **RPC access**:
  - Local Anvil fork, or
  - Blacklight L2 RPC (e.g. `https://rpc-blacklight-x9da3b5afc.t.conduit.xyz`).

### Install dependencies

```bash
cd contracts
forge install OpenZeppelin/openzeppelin-contracts foundry-rs/forge-std
```

### Build

```bash
forge build
```

### Test

```bash
# Unit tests (local)
forge test -vvv

# E2E Blacklight fork tests (require .env with DEPLOYER_PRIVATE_KEY, see .env.example)
anvil --fork-url https://rpc-blacklight-x9da3b5afc.t.conduit.xyz
forge test --match-path "test/e2e/*.t.sol" -vvv
```

## Deploy `PoolFactory`

1. **Prepare `.env`**

   ```bash
   cd contracts
   cp .env.example .env
   # Fill in NIL_TOKEN_ADDRESS, STAKING_CONTRACT_ADDRESS, REWARD_POLICY_ADDRESS,
   # PLATFORM_FEE_RECIPIENT, DEPLOYER_PRIVATE_KEY, and optionally BLACKLIGHT_L2_RPC_URL
   ```

2. **Deploy via Foundry script**

   ```bash
   # Load environment (optional but convenient)
   source .env 2>/dev/null || true

   forge script script/Deploy.s.sol:DeployBlacklightPool \
     --rpc-url "$BLACKLIGHT_L2_RPC_URL" \
     --broadcast \
     --private-key "$DEPLOYER_PRIVATE_KEY"
   ```

   The script deploys:

   - `PoolFactory` configured with the chain contracts from `.env`.
   - A single `BlacklightPool` implementation used as the clone template for all pools.

3. **After deployment**

   - Use the **UI** or direct `factory.createPool(...)` calls to create pools.
   - For each pool, the node operator must call `approveStaker(poolAddress)` on the `StakingOperators` contract so the pool can stake to that node.

