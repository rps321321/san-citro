import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { ThemeProvider } from "@/components/theme-provider";
import { TelemetryProvider } from "@/components/telemetry-provider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "San Citro",
  description: "Search, download, and manage your San Citro library",
};

/**
 * Blocking theme bootstrap (issue #62). Runs before first paint so StartupShell
 * and hydrated chrome use the correct light/dark tokens. Must stay aligned with
 * ThemeProvider: attribute=class, storageKey=theme, defaultTheme=dark, enableSystem.
 */
const THEME_BOOTSTRAP = `(function(){try{var s=localStorage.getItem('theme');var d;if(s==='light')d=false;else if(s==='dark')d=true;else if(s==='system')d=window.matchMedia('(prefers-color-scheme: dark)').matches;else d=true;var r=document.documentElement;r.classList.toggle('dark',d);r.style.colorScheme=d?'dark':'light';}catch(e){document.documentElement.classList.add('dark');document.documentElement.style.colorScheme='dark';}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        <ThemeProvider>
          <TelemetryProvider>{children}</TelemetryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
