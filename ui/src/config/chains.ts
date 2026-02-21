import { defineChain } from "viem";

const EXPLORER_URL = "https://explorer-blacklight-x9da3b5afc.t.conduit.xyz";
const LIVE_RPC = "https://rpc-blacklight-x9da3b5afc.t.conduit.xyz";
const LOCAL_RPC = "http://127.0.0.1:8545";

/**
 * Local Anvil fork (e.g. anvil --fork-url <LIVE_RPC> --chain-id 4811).
 * Use for E2E/testing with MetaMask; set NEXT_PUBLIC_BLACKLIGHT_NETWORK=local.
 */
export const blacklightLocal = defineChain({
  id: 4_811,
  name: "Nillion Blacklight (Local)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [LOCAL_RPC] } },
  blockExplorers: { default: { name: "Blockscout", url: EXPLORER_URL } },
});

/**
 * Live Nillion Blacklight L2 (chain 98875).
 * Default when NEXT_PUBLIC_BLACKLIGHT_NETWORK is unset or "production".
 */
export const blacklightProduction = defineChain({
  id: 98_875,
  name: "Nillion Blacklight",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [LIVE_RPC] } },
  blockExplorers: { default: { name: "Blockscout", url: EXPLORER_URL } },
});

/** "local" = Anvil fork (4811, 127.0.0.1:8545); anything else = production (98875, Conduit RPC). */
const useLocal =
  typeof process.env.NEXT_PUBLIC_BLACKLIGHT_NETWORK !== "undefined" &&
  process.env.NEXT_PUBLIC_BLACKLIGHT_NETWORK === "local";

/**
 * Active chain: use blacklightLocal when NEXT_PUBLIC_BLACKLIGHT_NETWORK=local, else blacklightProduction.
 * Restart dev server after changing .env.local.
 */
export const blacklight = useLocal ? blacklightLocal : blacklightProduction;
