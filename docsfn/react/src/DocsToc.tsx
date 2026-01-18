import React from 'react';
import { DocHeading } from '@docsfn/core';

export interface DocsTocProps {
  headings: DocHeading[];
  activeHash?: string;
}

export function DocsToc({ headings, activeHash }: DocsTocProps) {
  if (headings.length === 0) return null;

  return (
    <nav className="docsfn-toc">
      <div className="docsfn-toc-title">On this page</div>
      <ul>
        {headings.map((h) => (
          <li key={h.slug} style={{ paddingLeft: (h.level - 1) * 12 }}>
            <a 
              href={`#${h.slug}`}
              className={activeHash === `#${h.slug}` ? 'active' : ''}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
