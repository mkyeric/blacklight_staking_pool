# Blacklight Pool

A **non-custodial staking pool** for the **[Nillion Blacklight](https://blacklight.nillion.com/)** L2. Lets users with less than **70,000 NIL** participate in Blacklight rewards by pooling with others; one operator (verifier node) per pool.

- **Network:** Nillion Blacklight (Ethereum L2, Conduit)
- **ABIs:** [abis/](abis/) — NIL token, StakingOperators, RewardPolicy (see [abis/README.md](abis/README.md))

## Repository Structure

```
├── abis/                  # Contract ABIs for Blacklight L2
│   ├── NILToken.json
│   ├── StakingOperators.json
│   ├── RewardPolicy.json
│   └── README.md
├── contracts/             # Solidity (Foundry)
│   ├── src/
│   │   ├── BlacklightPool.sol
│   │   ├── PoolFactory.sol
│   │   └── interfaces/
│   ├── test/
│   ├── script/Deploy.s.sol
│   └── .env.example
├── ui/                    # Web frontend (Next.js)
│   ├── src/app/, components/, config/, hooks/, lib/
│   ├── src/abis/          # ABIs used by the UI
│   └── .env.example
└── README.md
```

## Contracts (Blacklight L2)

| Contract | Address | Purpose |
|----------|---------|---------|
| NIL Token (ERC-20) | `0x32DEAe728473cb948B4D8661ac0f2755133D4173` | Balances, approve, transferFrom |
| StakingOperators | `0x89c1312Cedb0B0F67e4913D2076bd4a860652B69` | stakeTo, requestUnstake, withdrawUnstaked, stakeOf |
| RewardPolicy | `0x78E0FEBF3B8936f961729328a25dBA88d4Fea86B` | claim() — pull verifier rewards into the pool |
| BlacklightPool | *(deploy per pool)* | User stake/withdraw, queue, reward settlement |

## What You Need to Set Up

### Development environment

- **Machine:** OS you are comfortable with (Windows/macOS/Linux).  
- **Node.js:** LTS version (e.g. 20.x) for tooling and front-end.  
- **Package manager:** npm or yarn.  
- **Ethereum dev stack:** [Hardhat](https://hardhat.org/) or [Foundry](https://book.getfoundry.sh/) for compiling and testing contracts.  
- **Version control:** Git.

### Nillion / Blacklight specifics

- **L2 RPC URL** for Nillion Blacklight (from Nillion or Conduit documentation; add to `.env` and never commit secrets).  
- **Chain ID** for the Blacklight L2.  
- **NIL token contract:** address `0x32DEAe728473cb948B4D8661ac0f2755133D4173`, ABI in [abis/NILToken.json](abis/NILToken.json). Use for user/pool NIL balances, `approve`, and `transferFrom`.  
- **Staking-to-node contract:** address `0x89c1312Cedb0B0F67e4913D2076bd4a860652B69`, ABI in [abis/StakingOperators.json](abis/StakingOperators.json). Use for `stakeTo(operator, amount)`, `requestUnstake`, `withdrawUnstaked`, and views `stakeOf`, `unstakeDelay`, `getUnbondingTranches`. The **node operator** must call `approveStaker(yourPoolAddress)` so your pool is the only address that can stake to that node.  
- **Reward policy contract:** address `0x78E0FEBF3B8936f961729328a25dBA88d4Fea86B`, ABI in [abis/RewardPolicy.json](abis/RewardPolicy.json). Use for `claim()` to pull verifier rewards into the pool and `rewardToken()` to verify token; rewards are sent to the pool as the approved staker.

### Running a Blacklight node (for pool operator)

- **Docker** (for the official Blacklight verifier image).  
- **Server or VM** with stable internet and minimal specs (see [Blacklight FAQ](https://blacklight.nillion.com/): e.g. 2 CPU, 1 GB RAM, 1 GB storage).  
- **Node wallet:** Generated during node setup

---

## Quick Start

### 1. Contracts

```bash
cd contracts
forge install OpenZeppelin/openzeppelin-contracts foundry-rs/forge-std
forge build
forge test -vvv
```

See [contracts/README.md](contracts/README.md) for deployment instructions.

### 2. Web UI

```bash
cd ui
npm install
cp .env.example .env.local
# Fill in your WalletConnect project ID and pool factory address
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The UI shows **Pools**, **My Pools**, **Keeper** (if applicable), and **Create Pool** (rightmost). Set `NEXT_PUBLIC_SHOW_CREATE_POOL=false` in `.env.local` to hide the Create Pool tab for staker-only builds. See [ui/README.md](ui/README.md) for details.

## How It Works

1. **Users stake NIL** into the pool (approve + stake); pool forwards it to the staking contract for the linked **operator** (verifier node).
2. **Node needs ≥ 70,000 NIL** to earn rewards. Owner’s stake (e.g. from existing node stake) + pool stakers count toward that.
3. **Rewards** are pulled into the pool via the reward policy `claim()`; they are settled and distributed to all stakers (including the owner) proportionally.
4. **Withdrawals** go through a queue: request → permissionless batch unstake from staking contract → unlock delay → claim. Only the **owner** is subject to a 70k NIL effective-stake floor when requesting a withdrawal in Active phase; other stakers are not. In **ShuttingDown** this floor is bypassed for everyone.

## Features

- **Non-custodial** — NIL only moves via defined contract actions; operator cannot unilaterally withdraw user stake.
- **Permissionless** — withdrawal batching and (when implemented) reward settlement can be triggered by anyone.
- **Bounded** — max 100 stakers per pool, max 100,000 NIL per staker (contract constants).
- **One operator = one pool** — each pool is tied to a single Blacklight node.
- **Shutdown** — Owner or platform keeper can initiate shutdown; a cooling-off period keeps the pool Active (stake allowed, owner 70k floor enforced). Only explicit **confirmShutdown()** transitions to ShuttingDown (no new stakes, owner 70k floor bypassed). See [requirements.md](requirements.md) FR-6.

## Contributing

Contributions welcome! Please open an issue first to discuss what you'd like to change.

## License

[MIT](LICENSE)
