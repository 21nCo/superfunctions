import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { baseOptions } from "@/app/layout.config";
import { source } from "@/lib/source";


export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout tree={source.getPageTree()} {...baseOptions()}
    sidebar={{
      footer: (
        <a
          href="https://21n.co"
          target="_blank"
          rel="noreferrer noopener"
          className="flex items-center w-full justify-center gap-2 px-2 pt-6 text-sm text-fd-muted-foreground hover:text-fd-foreground text-center"
        >
          Built at 21n.co
        </a>
      ),
      banner: (null),
    }}
    >
      {children}
    </DocsLayout>
  );
}
