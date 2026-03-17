import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        cockpit: {
          bg: "#0a0e0a",
          card: "#111614",
          border: "#1e2b1e",
          accent: "#4a7c59",
          text: "#d4e5d4",
          muted: "#6b8f6b",
          alert: "#ef4444",
          analysis: "#f59e0b",
          observation: "#22c55e",
        },
      },
      fontFamily: {
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
        sans: ["Inter", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
export default config;
