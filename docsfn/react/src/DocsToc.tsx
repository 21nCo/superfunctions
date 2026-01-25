import React, { useEffect, useState } from 'react';
import { DocHeading } from '@docsfn/core';
import { ScrollArea, ScrollAreaViewport } from '@uifn/react';

export interface DocsTocProps {
  headings: DocHeading[];
  activeHash?: string;
}

export function DocsToc({ headings, activeHash: activeHashProp }: DocsTocProps) {
  const [activeHash, setActiveHash] = useState(activeHashProp || '');

  // Auto-detect active heading based on scroll position
  useEffect(() => {
    if (activeHashProp !== undefined) {
      setActiveHash(activeHashProp);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const id = entry.target.getAttribute('id');
            if (id) {
              setActiveHash(`#${id}`);
            }
          }
        });
      },
      {
        rootMargin: '-80px 0px -80% 0px',
        threshold: 1.0,
      }
    );

    // Observe all heading elements
    headings.forEach((h) => {
      const element = document.getElementById(h.slug);
      if (element) {
        observer.observe(element);
      }
    });

    return () => observer.disconnect();
  }, [headings, activeHashProp]);

  if (headings.length === 0) return null;

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>, slug: string) => {
    e.preventDefault();
    const element = document.getElementById(slug);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveHash(`#${slug}`);
      // Update URL without triggering navigation
      window.history.replaceState(null, '', `#${slug}`);
    }
  };

  return (
    <ScrollArea className="docsfn-toc">
      <ScrollAreaViewport className="docsfn-toc-viewport">
        <nav className="docsfn-toc-nav" aria-label="Table of contents">
          <div className="docsfn-toc-title">On this page</div>
          <ul className="docsfn-toc-list">
            {headings.map((h) => {
              const isActive = activeHash === `#${h.slug}`;
              return (
                <li 
                  key={h.slug} 
                  className="docsfn-toc-item"
                  data-level={h.level}
                  style={{ paddingLeft: (h.level - 1) * 12 }}
                >
                  <a 
                    href={`#${h.slug}`}
                    onClick={(e) => handleClick(e, h.slug)}
                    className={`docsfn-toc-link ${isActive ? 'active' : ''}`}
                    data-active={isActive}
                    aria-current={isActive ? 'location' : undefined}
                  >
                    {h.text}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
      </ScrollAreaViewport>
    </ScrollArea>
  );
}
