import "./global.css";
import type { ReactNode } from "react";
import "@21n/fonts/styles.css";
import { RootProvider } from "fumadocs-ui/provider";
import { DocsRootLayout } from "@superfunctions/docs-theme";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsRootLayout>
      <RootProvider>{children}</RootProvider>
    </DocsRootLayout>
  );
}
