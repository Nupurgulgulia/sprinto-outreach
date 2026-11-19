import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sprinto Outreach",
  description:
    "Qualify SaaS prospects for Sprinto, find the right person, and draft a cold email, with every decision shown.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
