import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Blacklight-inspired palette
        blacklight: {
          bg: "#0a0a0f",
          surface: "#12121a",
          card: "#1a1a26",
          border: "#2a2a3a",
          "border-hover": "#3a3a4f",
          text: "#e8e8f0",
          "text-muted": "#8888a0",
          accent: "#7c5cfc",
          "accent-hover": "#9478ff",
          "accent-dim": "#7c5cfc20",
          success: "#34d399",
          warning: "#fbbf24",
          error: "#f87171",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
