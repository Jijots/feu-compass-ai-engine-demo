import type { Metadata } from "next";
import { Archivo, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/* Three faces, three jobs, self-hosted by next/font so there is no external
   request and no swap flash.

   Instrument Serif  the written voice: headlines, section titles, and the
                     analogy prose that explains the machine in human terms.
                     Ships 400 only, so emphasis is italic, never bold.
   Archivo           the working voice: every label, control, and value.
   JetBrains Mono    the machine voice: measurements, filenames, code. */

const display = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-display",
  display: "swap",
});

const sans = Archivo({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "FEU-COMPASS AI Engine — Demo",
  description:
    "Visual lost-and-found item matching demo (SIFT/RootSIFT, RANSAC, CLIP fallback) — UI styled after the original FEU-COMPASS system",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
