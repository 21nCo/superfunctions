import React, { useState } from 'react';
import { Sidebar, SidebarItem } from '@docsfn/core';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  ScrollArea,
  ScrollAreaViewport,
} from '@uifn/react';

export interface DocsSidebarProps {
  sidebar: Sidebar;
  activePath?: string;
  defaultCollapsedGroups?: string[];
}

export function DocsSidebar({ sidebar, activePath, defaultCollapsedGroups = [] }: DocsSidebarProps) {
  return (
    <ScrollArea className="docsfn-sidebar">
      <ScrollAreaViewport className="docsfn-sidebar-viewport">
        <nav className="docsfn-sidebar-nav">
          {sidebar.items.map((item, i) => (
            <SidebarGroup 
              key={i} 
              item={item} 
              activePath={activePath}
              defaultCollapsed={defaultCollapsedGroups.includes(item.text || '')}
            />
          ))}
        </nav>
      </ScrollAreaViewport>
    </ScrollArea>
  );
}

interface SidebarGroupProps {
  item: SidebarItem;
  activePath?: string;
  defaultCollapsed?: boolean;
  depth?: number;
}

function SidebarGroup({ item, activePath, defaultCollapsed = false, depth = 0 }: SidebarGroupProps) {
  if (item.type === 'separator') {
    return <hr className="docsfn-sidebar-separator" />;
  }

  if (item.type === 'group') {
    const hasActiveChild = hasActiveLink(item, activePath);
    
    return (
      <Collapsible 
        className="docsfn-sidebar-group" 
        data-depth={depth}
        defaultOpen={defaultCollapsed ? false : (item.collapsed === false || hasActiveChild)}
      >
        <CollapsibleTrigger className="docsfn-sidebar-group-trigger">
          <span className="docsfn-sidebar-group-icon">
            <svg 
              width="12" 
              height="12" 
              viewBox="0 0 12 12" 
              fill="none" 
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path 
                d="M4 3L7 6L4 9" 
                stroke="currentColor" 
                strokeWidth="1.5" 
                strokeLinecap="round" 
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="docsfn-sidebar-group-text">{item.text}</span>
        </CollapsibleTrigger>
        
        <CollapsibleContent className="docsfn-sidebar-group-content">
          {item.items?.map((sub, i) => (
            <SidebarGroup 
              key={i} 
              item={sub} 
              activePath={activePath}
              depth={depth + 1}
            />
          ))}
        </CollapsibleContent>
      </Collapsible>
    );
  }

  const isActive = activePath === item.link;
  return (
    <a 
      href={item.link} 
      className={`docsfn-sidebar-link ${isActive ? 'active' : ''}`}
      data-active={isActive}
      data-depth={depth}
      aria-current={isActive ? 'page' : undefined}
    >
      {item.text}
    </a>
  );
}

/**
 * Helper to check if any nested item has an active link
 */
function hasActiveLink(item: SidebarItem, activePath?: string): boolean {
  if (item.type === 'link' && item.link === activePath) {
    return true;
  }
  if (item.type === 'group' && item.items) {
    return item.items.some(child => hasActiveLink(child, activePath));
  }
  return false;
}
