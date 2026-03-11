import "./global.css";
import "@21n/fonts/styles.css";
import { RootProvider } from "fumadocs-ui/provider";
import { DocsRootLayout } from "@superfunctions/docs-theme";

type DocsRootLayoutProps = Parameters<typeof DocsRootLayout>[0];
type RootProviderProps = Parameters<typeof RootProvider>[0];

export default function Layout({ children }: { children: DocsRootLayoutProps["children"] }) {
  return (
    <DocsRootLayout>
      <RootProvider>{children as RootProviderProps["children"]}</RootProvider>
    </DocsRootLayout>
  );
}
