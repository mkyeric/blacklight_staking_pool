import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { blacklight } from "./chains";

/**
 * wagmi + RainbowKit config.
 *
 * NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is required for WalletConnect v2.
 * Get a free project ID at https://cloud.walletconnect.com/
 */
export const config = getDefaultConfig({
  appName: "Blacklight Pool",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "",
  chains: [blacklight],
  ssr: true,
});
