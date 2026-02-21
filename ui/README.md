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

The main tabs are **Pools**, **My Pools**, **Keeper** (if your wallet is a keeper), and **Create Pool** (rightmost; can be hidden via `NEXT_PUBLIC_SHOW_CREATE_POOL=false` for staker-only builds).

## Environment Variables

| Variable | Description |
|----------|------------|
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | WalletConnect v2 project ID ([get one free](https://cloud.walletconnect.com/)) |
| `NEXT_PUBLIC_SHOW_CREATE_POOL` | Set to `false` to hide the **Create Pool** tab and build a staker-only UI. Omit or set to `true` to show the Create Pool tab (rightmost in the tab bar). |

The PoolFactory contract address is defined in `src/config.ts` so validators and users can see which contract the UI interacts with. Pools must only be created via the factory (Create Pool wizard uses `createPool`).

## Tech Stack

- [Next.js 14](https://nextjs.org/) (App Router)
- [TypeScript](https://www.typescriptlang.org/)
- [wagmi v2](https://wagmi.sh/) + [viem v2](https://viem.sh/)
- [RainbowKit v2](https://www.rainbowkit.com/)
- [Tailwind CSS 3](https://tailwindcss.com/)
