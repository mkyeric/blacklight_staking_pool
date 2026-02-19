# Blacklight Pool — Smart Contracts

Solidity contracts for the Blacklight staking pool, built with [Foundry](https://book.getfoundry.sh/).

## Contracts

| Contract | Path | Description |
|----------|------|-------------|
| `BlacklightPool` | `src/BlacklightPool.sol` | Non-custodial staking pool that aggregates user NIL to meet the 70k minimum; supports voluntary shutdown (cooling-off then explicit confirmShutdown to enter ShuttingDown) |
| `PoolFactory` | `src/PoolFactory.sol` | Creates new pools as clones and initializes them in the same transaction (required for safe pool creation). |
| `IStakingOperators` | `src/interfaces/IStakingOperators.sol` | Interface for Nillion's on-chain staking contract |

### Pool creation (security)

**Pools must only be created via `PoolFactory.createPool()`.** The pool implementation is clone-ready: `initialize()` has no access control, so the first caller sets the owner and operator. If a pool is deployed or cloned without using the factory, an attacker can front-run `initialize()` and become the owner (and commission recipient). The factory deploys a clone and calls `initialize()` in the same transaction, so there is no public window to front-run. The UI uses the factory for all pool creation (Create Pool wizard).

## Setup

### Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation) installed

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
forge test -vvv
```

### Deploy

```bash
cp .env.example .env
# Edit .env with your values

source .env
forge script script/Deploy.s.sol:DeployBlacklightPool --rpc-url $BLACKLIGHT_L2_RPC_URL --broadcast --private-key "$DEPLOYER_PRIVATE_KEY"
```

After deployment, the node operator must call `approveStaker(poolAddress)` on the staking contract so the pool can stake to the node.
