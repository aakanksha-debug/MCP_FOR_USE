import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Incrementors Website Audit MCP",
  description: "Free SEO, AEO, GEO, local, technical, schema, conversion and content audits for Claude, with optional Search Console and GA4 verification.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
