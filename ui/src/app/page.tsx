"use client";

import { useState, useCallback, useEffect } from "react";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { PoolList, PoolListMyPools } from "@/components/PoolList";
import { PoolListKeeper } from "@/components/PoolListKeeper";
import { CreatePoolWizard } from "@/components/CreatePoolWizard";
import { useKeeperPools } from "@/hooks/useKeeperPools";

type TabId = "pools" | "mypools" | "keeper" | "create";

export default function Home() {
  const [activeTab, setActiveTab] = useState<TabId>("pools");
  const [scrollToPoolAddress, setScrollToPoolAddress] = useState<string | null>(null);
  const { isKeeper } = useKeeperPools();
  const showCreatePool =
    process.env.NEXT_PUBLIC_SHOW_CREATE_POOL !== "false";

  useEffect(() => {
    if (!showCreatePool && activeTab === "create") setActiveTab("pools");
  }, [showCreatePool, activeTab]);

  const handleStakeSuccess = useCallback((poolAddress: string) => {
    setActiveTab("mypools");
    setScrollToPoolAddress(poolAddress);
  }, []);

  return (
    <div className="flex min-h-screen flex-col">
      <Header />

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-6 py-10">
        {/* Hero */}
        <section className="text-center">
          <h1 className="mb-5 text-3xl font-bold tracking-tight sm:text-4xl">
            Blacklight Pool
          </h1>
          <div className="mx-auto max-w-2xl space-y-4 text-blacklight-text-muted">
            <p>
              Nillion has announced that Blacklight staking is moving from L2 to
              Ethereum L1. As a result, the current L2 staking setup — and
              Blacklight Pool — will be wound down. See the{" "}
              <a
                href="https://x.com/nillion/status/2103816658083357083?s=20"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blacklight-accent transition-colors hover:text-blacklight-accent-hover"
              >
                official announcement
              </a>
              .
            </p>
            <p>
              If you currently have NIL staked through Blacklight Pool, please
              withdraw your funds.
            </p>
            <p>
              Thank you to everyone who trusted and supported Blacklight Pool. It
              has been a pleasure building this community staking solution and
              helping smaller NIL holders participate in Blacklight staking.
            </p>
          </div>
        </section>

        {/* Tabs */}
        <div className="border-b border-blacklight-border">
          <nav className="flex gap-6" aria-label="Main">
            <button
              type="button"
              onClick={() => setActiveTab("pools")}
              className={`-mb-px border-b-2 px-1 py-3 text-sm font-medium transition-colors ${
                activeTab === "pools"
                  ? "border-blacklight-accent text-blacklight-accent"
                  : "border-transparent text-blacklight-text-muted hover:border-blacklight-border hover:text-blacklight-text"
              }`}
            >
              Pools
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("mypools")}
              className={`-mb-px border-b-2 px-1 py-3 text-sm font-medium transition-colors ${
                activeTab === "mypools"
                  ? "border-blacklight-accent text-blacklight-accent"
                  : "border-transparent text-blacklight-text-muted hover:border-blacklight-border hover:text-blacklight-text"
              }`}
            >
              My Pools
            </button>
            {isKeeper && (
              <button
                type="button"
                onClick={() => setActiveTab("keeper")}
                className={`-mb-px border-b-2 px-1 py-3 text-sm font-medium transition-colors ${
                  activeTab === "keeper"
                    ? "border-blacklight-accent text-blacklight-accent"
                    : "border-transparent text-blacklight-text-muted hover:border-blacklight-border hover:text-blacklight-text"
                }`}
              >
                Keeper
              </button>
            )}
            {showCreatePool && (
              <button
                type="button"
                onClick={() => setActiveTab("create")}
                className={`-mb-px ml-auto border-b-2 px-1 py-3 text-sm font-medium transition-colors ${
                  activeTab === "create"
                    ? "border-blacklight-accent text-blacklight-accent"
                    : "border-transparent text-blacklight-text-muted hover:border-blacklight-border hover:text-blacklight-text"
                }`}
              >
                Create Pool
              </button>
            )}
          </nav>
        </div>

        {/* Tab content */}
        {activeTab === "pools" && <PoolList onStakeSuccess={handleStakeSuccess} />}

        {activeTab === "mypools" && (
          <PoolListMyPools
            scrollToPoolAddress={scrollToPoolAddress}
            onScrollComplete={() => setScrollToPoolAddress(null)}
          />
        )}

        {activeTab === "keeper" && <PoolListKeeper />}

        {showCreatePool && activeTab === "create" && <CreatePoolWizard />}
      </main>

      <Footer />
    </div>
  );
}
