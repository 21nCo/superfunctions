'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTheme } from 'next-themes';

export function Mermaid({ chart }: { chart: string }) {
  const id = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    import('mermaid').then(({ default: mermaid }) => {
      if (cancelled) return;

      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'loose',
        fontFamily: 'inherit',
        themeCSS: 'margin: 1.5rem auto 0;',
        theme: resolvedTheme === 'dark' ? 'dark' : 'default',
      });

      const renderId = id.replace(/:/g, '-');
      mermaid.render(renderId, chart.replaceAll('\\n', '\n')).then((result) => {
        if (cancelled) return;
        setSvg(result.svg);
        if (containerRef.current) {
          result.bindFunctions?.(containerRef.current);
        }
      });
    });

    return () => {
      cancelled = true;
    };
  }, [id, chart, resolvedTheme]);

  if (!svg) return null;

  return (
    <div
      ref={containerRef}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
