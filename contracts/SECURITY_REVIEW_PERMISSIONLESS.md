# Security Review: Permissionless Functions

This document reviews all **permissionless** (callable by anyone) functions in the pool contracts for security issues: fund theft, locking user funds, or redirecting funds to an attacker.

---

## 1. BlacklightPool – Permissionless Functions

| Function | Who can call | What it does |
|----------|----------------|---------------|
| `initialize(...)` | Anyone (once per clone) | Sets operator, owner, commission, minStake. |
| `stake(amount)` | Anyone | Deposits NIL from `msg.sender` into the pool. |
| `requestWithdraw(amount)` | Anyone | Queues a withdrawal for `msg.sender` only. |
| `processWithdrawalBatch(maxEntries)` | Anyone | Aggregates queued requests, calls staking `requestUnstake(operator, totalAmount)`, sets unlock times. |
| `pullUnstakedFromStaking()` | Anyone | Pulls matured NIL from staking contract **into the pool** (no recipient parameter). |
| `claimWithdrawals()` | Anyone | Claims **msg.sender’s** claimable withdrawals → sends NIL to **msg.sender**. |
| `processUserWithdrawals(user)` | Anyone | Claims **user’s** claimable withdrawals → sends NIL to **user** (not to caller). |

---

## 2. Outbound Transfers (Only Two Code Paths)

- **Stake:** `nilToken.safeTransferFrom(msg.sender, address(this), amount)` — pulls from caller only.
- **Claim:** `nilToken.safeTransfer(beneficiary, toTransfer)` in `_claimFor(user, beneficiary)`:
  - `claimWithdrawals()` → `_claimFor(msg.sender, msg.sender)` → beneficiary = msg.sender.
  - `processUserWithdrawals(user)` → `_claimFor(user, user)` → beneficiary = user.

There is **no** function that takes an arbitrary recipient or sends pool NIL to the caller when the caller is not the rightful owner of the claim.

---

## 3. Security Findings

### 3.1 No fund theft via permissionless functions

- **processUserWithdrawals(user):** Funds are sent to `user`, not to `msg.sender`. A keeper or attacker calling this for a user does **not** receive the user’s NIL.
- **processWithdrawalBatch / pullUnstakedFromStaking:** Neither sends tokens to any address; they only move NIL from the staking contract to the pool or update queue state.
- **claimWithdrawals:** Only sends to `msg.sender` for their own claimable queue entries.

**Conclusion:** There is no permissionless path for an attacker to steal pool or user funds.

### 3.2 No locking of user funds by permissionless design

- Withdrawals are unlocked by **processWithdrawalBatch** (permissionless) and **pullUnstakedFromStaking** (permissionless). So even if the owner does nothing, anyone can:
  - Process the withdrawal batch (set unlock timestamps).
  - Pull unstaked NIL back into the pool.
- Users (or keepers) can then call **claimWithdrawals** / **processUserWithdrawals** to receive NIL.

**Conclusion:** User funds are not lockable by a malicious or inactive owner via these functions; the critical path is permissionless.

### 3.3 initialize() – front‑run / takeover risk (only when not using factory)

- **initialize()** has no access control and can be called once per clone by anyone.
- **Current factory:** `createPool` does `Clones.clone` + `initialize(...)` in one transaction, so the intended owner is set atomically. No front-run window.
- **If someone deploys a clone manually** (e.g. direct `Clones.clone` then later `initialize` in another tx), an attacker could front-run the second tx and call `initialize(attackerOperator, attacker, ...)` to become owner.

**Mitigation:** Always create pools via `PoolFactory.createPool` so initialization is in the same tx as clone creation. Document that clones must not be initialized in a separate transaction.

### 3.4 Claim accounting and partial liquidity

- `_claimFor` uses `idleBalance = nilToken.balanceOf(address(this))` and stops adding to `toTransfer` when `toTransfer + q[i].amount > idleBalance`, then transfers exactly `toTransfer`. So the contract never transfers more than it holds, and `totalPendingWithdrawals` is only decremented for requests actually marked `claimed`.
- If the pool has insufficient idle NIL, some claimable requests may be left unclaimed until more NIL is available (e.g. after `pullUnstakedFromStaking`). This is first-come-first-served within available balance; no double-spend or accounting bug.

### 3.5 totalUnstakingRequested and pullUnstakedFromStaking

- When `received > totalUnstakingRequested`, the code sets `totalUnstakingRequested = 0` (no underflow). Extra NIL (e.g. if the staking contract returned more than requested) stays in the pool and is safe.

---

## 4. PoolFactory

- **createPool(operator, owner, commissionBps, minStakePerUser):** Permissionless. Anyone can create a pool with any parameters. This is by design (e.g. anyone can create their own pool). It does not grant access to other pools or their funds.

---

## 5. Summary

| Risk | Status |
|------|--------|
| Stealing funds via permissionless functions | **None found** – claims only go to the user who owns the queue entries. |
| Locking user funds by not calling batch/pull | **Mitigated** – processWithdrawalBatch and pullUnstakedFromStaking are permissionless. |
| Redirecting withdrawals to attacker | **None** – processUserWithdrawals sends to `user`, not to caller. |
| initialize() takeover | **Only** if a clone is initialized in a separate tx; use factory to avoid. |

**Recommendation:** Use `PoolFactory.createPool` for all pool creation so initialization cannot be front-run. No changes required to permissionless logic for fund safety; the design is secure for the stated threat model.

---

## 6. Double-check (audit pass)

All permissionless and privileged functions were re-verified for:

- **Fund theft:** Caller cannot receive pool or user funds except (1) their own stake via `requestWithdraw` + `claimWithdrawals`, or (2) as the designated `user` in `processUserWithdrawals(user)` (user receives, not caller).
- **Locking user funds:** Withdrawal path is permissionless (`processWithdrawalBatch`, `pullUnstakedFromStaking`, `claimWithdrawals` / `processUserWithdrawals`), so no single party can block withdrawals.
- **Sending to wrong address:** Only two NIL outbound paths exist: (1) `stake` → `transferFrom(msg.sender, pool)`; (2) `_claimFor` → `transfer(beneficiary)` where `beneficiary` is always the user whose queue is being claimed (no arbitrary recipient parameter anywhere).

**Explicit permissionless function list (BlacklightPool):**

| Function | Access | NIL movement | Verdict |
|----------|--------|----------------|--------|
| `initialize` | Anyone, once | None | Safe if clone is created + initialized in one tx (e.g. via factory). |
| `stake(amount)` | Anyone | Pull from `msg.sender` only | Safe. |
| `requestWithdraw(amount)` | Anyone | Deduct from `msg.sender` only, add to queue | Safe. |
| `processWithdrawalBatch(maxEntries)` | Anyone | Calls staking `requestUnstake`; no NIL to caller | Safe. |
| `pullUnstakedFromStaking()` | Anyone | NIL from staking → pool only | Safe. |
| `claimWithdrawals()` | Anyone | NIL to `msg.sender` only (own queue) | Safe. |
| `processUserWithdrawals(user)` | Anyone | NIL to `user`, not caller | Safe. |

**Owner-only functions:** `initOwnerNodeStake`, `forwardStakeToNode`, `claimVerifierRewards` — none send pool NIL to the owner; NIL either stays in pool, goes to staking contract, or is pulled from reward policy into pool. **No security hole found** in permissionless or owner functions for theft, lock, or redirect.
