import { defineChain } from "viem";

/**
 * Nillion Blacklight L2 chain definition.
 *
 * RPC and chain-ID sourced from:
 * - Conduit explorer: https://explorer-blacklight-x9da3b5afc.t.conduit.xyz/
 * - Nillion docs: https://blacklight.nillion.com/
 *
 * Update the RPC URL if Nillion publishes a different public endpoint.
 */
export const blacklight = defineChain({
  id: 4_811, // Nillion Blacklight chain ID
  name: "Nillion Blacklight",
  nativeCurrency: {
    name: "Ether",
    symbol: "ETH",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ["http://127.0.0.1:8545"],
    },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://explorer-blacklight-x9da3b5afc.t.conduit.xyz",
    },
  },
});
