import "./global.css";
import "@21n/fonts/styles.css";
import { RootProvider } from "fumadocs-ui/provider";
import { DocsRootLayout } from "@superfunctions/docs-theme";
import type { Metadata } from "next";
import type React from "react";

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:6003");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "SecFn Docs",
    template: "%s | SecFn Docs",
  },
  description:
    "Documentation for SecFn, secrets, scanning, RBAC, rate limiting, and security monitoring in Superfunctions.",
  openGraph: {
    type: "website",
    url: siteUrl,
    siteName: "SecFn Docs",
    title: "SecFn Docs",
    description:
      "Documentation for SecFn, secrets, scanning, RBAC, rate limiting, and security monitoring in Superfunctions.",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "SecFn Docs",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "SecFn Docs",
    description:
      "Documentation for SecFn, secrets, scanning, RBAC, rate limiting, and security monitoring in Superfunctions.",
    images: ["/opengraph-image"],
  },
};

type DocsRootLayoutProps = Parameters<typeof DocsRootLayout>[0];
const FumadocsRootProvider = RootProvider as unknown as (props: { children: unknown }) => React.ReactElement;

export default function Layout({ children }: { children: DocsRootLayoutProps["children"] }) {
  return (
    <DocsRootLayout>
      <FumadocsRootProvider>{children}</FumadocsRootProvider>
    </DocsRootLayout>
  );
}
