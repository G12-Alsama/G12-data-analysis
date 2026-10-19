import type { Metadata } from "next";
import { Sofia_Sans, IBM_Plex_Mono, Barlow } from "next/font/google";
import "./globals.css";
import { DataProviderRoot } from "@/lib/data/context";

const sofia = Sofia_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-sofia",
  display: "swap",
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-mono",
  display: "swap",
});
// Barlow is open-licensed and is the report template's body font. Loading it
// in-browser keeps the document preview's text-overflow checks accurate.
const barlow = Barlow({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-barlow",
  display: "swap",
});

export const metadata: Metadata = {
  title: "G12++ Candidate Performance App",
  description:
    "Process MCQ exam results: ingest, review item quality, set grade boundaries, assign and sign off grades.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${sofia.variable} ${plexMono.variable} ${barlow.variable}`}
    >
      <body>
        <DataProviderRoot>{children}</DataProviderRoot>
      </body>
    </html>
  );
}
