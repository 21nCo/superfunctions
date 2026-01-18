import React, { ReactNode } from 'react';
import { Sidebar, DocHeading } from '@docsfn/core';
import { DocsSidebar } from './DocsSidebar';
import { DocsToc } from './DocsToc';

export interface DocsLayoutProps {
  children: ReactNode;
  sidebar?: Sidebar;
  headings?: DocHeading[];
  activePath?: string;
  topbar?: ReactNode;
}

export function DocsLayout({ children, sidebar, headings, activePath, topbar }: DocsLayoutProps) {
  return (
    <div className="docsfn-layout">
      {topbar && <header className="docsfn-topbar">{topbar}</header>}
      
      <div className="docsfn-container">
        {sidebar && (
          <aside className="docsfn-sidebar-col">
            <DocsSidebar sidebar={sidebar} activePath={activePath} />
          </aside>
        )}
        
        <main className="docsfn-main">
          {children}
        </main>
        
        {headings && headings.length > 0 && (
          <aside className="docsfn-toc-col">
            <DocsToc headings={headings} />
          </aside>
        )}
      </div>
    </div>
  );
}
