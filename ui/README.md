# Blacklight Pool — Web UI

Next.js frontend for the Blacklight staking pool.

## Setup

```bash
cd ui
npm install
cp .env.example .env.local
# Edit .env.local with your values
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment Variables

| Variable | Description |
|----------|------------|
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | WalletConnect v2 project ID ([get one free](https://cloud.walletconnect.com/)) |
| `NEXT_PUBLIC_POOL_FACTORY_ADDRESS` | PoolFactory contract address (required). **Pools must only be created via the factory** (Create Pool wizard uses `createPool`); creating pools any other way risks front-running of `initialize()` and wrong owner. Deploy via `forge script script/Deploy.s.sol:DeployBlacklightPool` |

## Tech Stack

- [Next.js 14](https://nextjs.org/) (App Router)
- [TypeScript](https://www.typescriptlang.org/)
- [wagmi v2](https://wagmi.sh/) + [viem v2](https://viem.sh/)
- [RainbowKit v2](https://www.rainbowkit.com/)
- [Tailwind CSS 3](https://tailwindcss.com/)
