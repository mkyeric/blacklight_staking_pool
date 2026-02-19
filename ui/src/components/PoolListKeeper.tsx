"use client";

import { useKeeperPools } from "@/hooks/useKeeperPools";
import { KeeperOperations } from "@/components/KeeperOperations";
import { parsePoolDisplayName } from "@/lib/poolMetadata";
import { useReadContract } from "wagmi";
import { STAKING_OPERATORS_ADDRESS, stakingOperatorsAbi } from "@/lib/contracts";

export function PoolListKeeper() {
  const { keeperPools, isLoading } = useKeeperPools();

  if (isLoading) {
    return (
      <section className="card p-6 text-center">
        <h2 className="mb-2 text-xl font-semibold">Keeper Operations</h2>
        <p className="text-sm text-blacklight-text-muted">Loading pools…</p>
      </section>
    );
  }

  if (keeperPools.length === 0) {
    return (
      <section className="card p-6 text-center">
        <h2 className="mb-2 text-xl font-semibold">Keeper Operations</h2>
        <p className="text-sm text-blacklight-text-muted">
          You are not the platform fee recipient for any pool. Connect with the platform fee
          recipient wallet to see keeper operations.
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      <div className="card p-4">
        <h2 className="mb-2 text-xl font-semibold">Keeper Operations</h2>
        <p className="text-sm text-blacklight-text-muted">
          Permissionless contract calls: settle epoch, process withdrawals, pull unstaked NIL.
          Only visible to the platform fee recipient for each pool.
        </p>
      </div>
      {keeperPools.map((pool) => (
        <PoolKeeperCard key={pool.pool} pool={pool} />
      ))}
    </section>
  );
}

function PoolKeeperCard({ pool }: { pool: { pool: `0x${string}`; operator: `0x${string}` } }) {
  const { data: operatorInfo } = useReadContract({
    address: STAKING_OPERATORS_ADDRESS,
    abi: stakingOperatorsAbi,
    functionName: "getOperatorInfo",
    args: [pool.operator],
  });

  const operatorMetadataURI =
    operatorInfo !== undefined &&
    operatorInfo !== null &&
    typeof operatorInfo === "object" &&
    "metadataURI" in operatorInfo &&
    typeof (operatorInfo as { metadataURI?: string }).metadataURI === "string"
      ? (operatorInfo as { metadataURI: string }).metadataURI
      : Array.isArray(operatorInfo) && operatorInfo.length >= 2 && typeof operatorInfo[1] === "string"
        ? (operatorInfo[1] as string)
        : "";

  const poolDisplayName = parsePoolDisplayName(operatorMetadataURI, pool.pool);

  return (
    <article className="card p-6">
      <h3 className="mb-2 text-lg font-semibold text-blacklight-text">{poolDisplayName}</h3>
      <p className="mb-4 text-xs text-blacklight-text-muted break-all">
        Pool: <span className="font-mono">{pool.pool}</span>
      </p>
      <KeeperOperations poolAddress={pool.pool} />
    </article>
  );
}
