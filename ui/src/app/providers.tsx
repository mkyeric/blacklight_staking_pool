"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import {
  RainbowKitProvider,
  darkTheme,
  type Theme,
} from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { config } from "@/config/wagmi";
import { useState, type ReactNode } from "react";

/**
 * Custom RainbowKit theme that matches the Blacklight palette.
 */
const blacklightTheme: Theme = {
  ...darkTheme({
    accentColor: "#7c5cfc",
    accentColorForeground: "#ffffff",
    borderRadius: "large",
  }),
  colors: {
    ...darkTheme().colors,
    modalBackground: "#12121a",
    modalBorder: "#2a2a3a",
    profileForeground: "#1a1a26",
    generalBorder: "#2a2a3a",
    generalBorderDim: "#1a1a26",
  },
  fonts: {
    body: "Inter, system-ui, sans-serif",
  },
};

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={blacklightTheme}>
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
