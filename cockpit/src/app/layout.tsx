import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GEOSCOPE COCKPIT",
  description: "Real-time intelligence monitoring dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="bg-cockpit-bg text-cockpit-text font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
