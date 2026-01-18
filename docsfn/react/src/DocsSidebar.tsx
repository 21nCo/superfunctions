import React from 'react';
import { Sidebar, SidebarItem } from '@docsfn/core';

export interface DocsSidebarProps {
  sidebar: Sidebar;
  activePath?: string;
}

export function DocsSidebar({ sidebar, activePath }: DocsSidebarProps) {
  return (
    <nav className="docsfn-sidebar">
      {sidebar.items.map((item, i) => (
        <SidebarGroup key={i} item={item} activePath={activePath} />
      ))}
    </nav>
  );
}

function SidebarGroup({ item, activePath }: { item: SidebarItem; activePath?: string }) {
  if (item.type === 'separator') {
    return <hr className="docsfn-sidebar-separator" />;
  }

  if (item.type === 'group') {
    return (
      <div className="docsfn-sidebar-group">
        <div className="docsfn-sidebar-group-title">{item.text}</div>
        <div className="docsfn-sidebar-group-items">
          {item.items?.map((sub, i) => (
            <SidebarGroup key={i} item={sub} activePath={activePath} />
          ))}
        </div>
      </div>
    );
  }

  const isActive = activePath === item.link;
  return (
    <a 
      href={item.link} 
      className={`docsfn-sidebar-link ${isActive ? 'active' : ''}`}
    >
      {item.text}
    </a>
  );
}
