import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FEU-COMPASS AI Engine — Demo",
  description:
    "Visual lost-and-found item matching demo (SIFT/RootSIFT, RANSAC, CLIP fallback) — UI styled after the original FEU-COMPASS system",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Public+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,400&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
