'use client';

import { useEffect, useId, useState } from 'react';
import { useTheme } from 'next-themes';

export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/:/g, '-');
  const { resolvedTheme } = useTheme();
  const [svg, setSvg] = useState<string>('');

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram(): Promise<void> {
      const { default: mermaid } = await import('mermaid');
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        fontFamily: 'inherit',
        themeCSS: 'margin: 1.5rem auto 0;',
        theme: resolvedTheme === 'dark' ? 'dark' : 'default',
      });

      const rendered = await mermaid.render(`mermaid-${id}`, chart.replaceAll('\\n', '\n'));
      if (!cancelled) {
        setSvg(rendered.svg);
      }
    }

    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [chart, id, resolvedTheme]);

  if (!svg) {
    return null;
  }

  return <div dangerouslySetInnerHTML={{ __html: svg }} />;
}
