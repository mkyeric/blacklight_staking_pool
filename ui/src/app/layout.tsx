import type { Metadata } from "next";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Blacklight Pool — Nillion Staking Pool",
  description:
    "Pool your NIL tokens with others to meet the 70,000 NIL minimum and earn Blacklight verification rewards.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
