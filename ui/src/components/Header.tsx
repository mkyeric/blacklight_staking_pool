"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useReadContract } from "wagmi";
import { formatUnits } from "viem";
import { NIL_TOKEN_ADDRESS, NIL_DECIMALS, nilTokenAbi } from "@/lib/contracts";

function formatNil(balance: bigint | undefined) {
  if (balance === undefined) return null;
  const n = Number(formatUnits(balance, NIL_DECIMALS));
  return n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(2)}k`
      : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function Header() {
  const { address, isConnected } = useAccount();
  const { data: nilBalance } = useReadContract({
    address: NIL_TOKEN_ADDRESS,
    abi: nilTokenAbi,
    functionName: "balanceOf",
    args: [address!],
    query: { enabled: isConnected && !!address },
  });

  const nilFormatted = formatNil(nilBalance as bigint | undefined);

  return (
    <header className="sticky top-0 z-50 border-b border-blacklight-border bg-blacklight-bg/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        {/* Logo / Brand */}
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blacklight-accent">
            <span className="text-sm font-bold text-white">B</span>
          </div>
          <span className="text-lg font-semibold tracking-tight text-blacklight-text">
            Blacklight Pool
          </span>
        </div>

        {/* Wallet connect — custom display with ETH + NIL */}
        <ConnectButton.Custom>
          {({
            account,
            chain,
            openAccountModal,
            openChainModal,
            openConnectModal,
            mounted,
          }) => {
            if (!mounted) return null;
            if (!account || !chain) {
              return (
                <button
                  onClick={openConnectModal}
                  type="button"
                  className="flex items-center gap-2 rounded-lg border border-blacklight-border bg-blacklight-surface px-4 py-2 text-sm font-medium text-blacklight-text transition hover:bg-blacklight-border"
                >
                  Connect Wallet
                </button>
              );
            }
            const ethPart = account.displayBalance ?? null;
            const nilPart = nilFormatted ? `${nilFormatted} NIL` : null;
            const balances = [ethPart, nilPart].filter(Boolean).join(" · ");
            return (
              <div className="flex items-center gap-2">
                {balances ? (
                  <span className="hidden text-sm text-blacklight-text-muted sm:inline">
                    {balances}
                  </span>
                ) : null}
                <button
                  onClick={openChainModal}
                  type="button"
                  className="flex items-center gap-1.5 rounded-lg border border-blacklight-border bg-blacklight-surface px-2 py-1.5 text-sm transition hover:bg-blacklight-border"
                  title={chain.name}
                >
                  {chain.hasIcon && chain.iconUrl && (
                    <img
                      alt={chain.name}
                      src={chain.iconUrl}
                      className="h-4 w-4 rounded-full"
                    />
                  )}
                </button>
                <button
                  onClick={openAccountModal}
                  type="button"
                  className="flex items-center gap-2 rounded-lg border border-blacklight-border bg-blacklight-surface px-3 py-2 text-sm font-medium text-blacklight-text transition hover:bg-blacklight-border"
                >
                  {account.displayName}
                </button>
              </div>
            );
          }}
        </ConnectButton.Custom>
      </div>
    </header>
  );
}
