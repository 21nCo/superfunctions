import React from "react";
import type { Sidebar, SidebarItem } from "@docsfn/core";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ScrollArea,
  ScrollAreaViewport,
} from "@uifn/react";
import type { DocsPageSurface } from "./DocsLayout";

export interface DocsSidebarProps {
  surface?: DocsPageSurface;
  sidebar?: Sidebar;
  activePath?: string;
  defaultCollapsedGroups?: string[];
}

export function DocsSidebar({
  surface,
  sidebar,
  activePath,
  defaultCollapsedGroups = [],
}: DocsSidebarProps) {
  const resolvedSidebar = sidebar ?? surface?.sidebar;
  const resolvedActivePath = activePath ?? surface?.route;

  if (!resolvedSidebar) {
    return null;
  }

  return (
    <ScrollArea className="docsfn-sidebar">
      <ScrollAreaViewport className="docsfn-sidebar-viewport">
        <nav className="docsfn-sidebar-nav">
          {resolvedSidebar.items.map((item, index) => (
            <SidebarGroup
              key={`${item.type}:${index}`}
              item={item}
              activePath={resolvedActivePath}
              defaultCollapsed={defaultCollapsedGroups.includes(item.text || "")}
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

function SidebarGroup({
  item,
  activePath,
  defaultCollapsed = false,
  depth = 0,
}: SidebarGroupProps) {
  if (item.type === "separator") {
    return <hr className="docsfn-sidebar-separator" />;
  }

  if (item.type === "group") {
    const hasActiveChild = hasActiveLink(item, activePath);
    const defaultOpen =
      defaultCollapsed !== true && (item.collapsed === false || hasActiveChild);

    return (
      <Collapsible className="docsfn-sidebar-group" data-depth={depth} defaultOpen={defaultOpen}>
        <CollapsibleTrigger className="docsfn-sidebar-group-trigger">
          <span className="docsfn-sidebar-group-icon" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
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
          {item.items?.map((child, childIndex) => (
            <SidebarGroup
              key={`${child.type}:${childIndex}`}
              item={child}
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
      className={`docsfn-sidebar-link ${isActive ? "active" : ""}`}
      data-active={isActive}
      data-depth={depth}
      aria-current={isActive ? "page" : undefined}
    >
      {item.text}
    </a>
  );
}

function hasActiveLink(item: SidebarItem, activePath?: string): boolean {
  if (item.type === "link" && item.link === activePath) {
    return true;
  }
  if (item.type === "group" && item.items) {
    return item.items.some((child) => hasActiveLink(child, activePath));
  }
  return false;
}
