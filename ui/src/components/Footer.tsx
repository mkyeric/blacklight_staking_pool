import { POOL_FACTORY_ADDRESS } from "@/config";
import { blacklight } from "@/config/chains";

export function Footer() {
  const explorerUrl = blacklight.blockExplorers?.default?.url ?? "";
  const contractAddressUrl = explorerUrl
    ? `${explorerUrl}/address/${POOL_FACTORY_ADDRESS}`
    : "#";

  return (
    <footer className="border-t border-blacklight-border py-8 text-center text-sm text-blacklight-text-muted">
      <div className="mx-auto max-w-5xl px-6">
        <p>
          Blacklight Pool &mdash; Community staking for{" "}
          <a
            href="https://blacklight.nillion.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blacklight-accent transition-colors hover:text-blacklight-accent-hover"
          >
            Nillion Blacklight
          </a>
          {" · "}
          <a
            href="https://github.com/mkyeric/blacklight_staking_pool"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blacklight-accent transition-colors hover:text-blacklight-accent-hover"
          >
            Source (GitHub)
          </a>
          {" · "}
          <a
            href={contractAddressUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blacklight-accent transition-colors hover:text-blacklight-accent-hover"
          >
            Contract address
          </a>
        </p>
      </div>
    </footer>
  );
}
