import React from "react";
import type { DocsTopNavItem } from "@docsfn/core";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@uifn/react";
import type { DocsPageSurface } from "./DocsLayout";

export interface TopBarLink {
  label: string;
  href: string;
  external?: boolean;
}

export interface TopBarDropdown {
  label: string;
  items: TopBarLink[];
}

export type TopBarItem = TopBarLink | TopBarDropdown;

export interface TopBarProps {
  surface?: DocsPageSurface;
  logo?: React.ReactNode;
  items?: TopBarItem[];
  searchTrigger?: React.ReactNode;
  versionSelector?: React.ReactNode;
  mobileMenuTrigger?: React.ReactNode;
  className?: string;
}

function isDropdown(item: TopBarItem): item is TopBarDropdown {
  return "items" in item;
}

function mapTopNavItems(topNav: DocsTopNavItem[]): TopBarItem[] {
  return topNav.map((item) => {
    if (Array.isArray(item.children) && item.children.length > 0) {
      return {
        label: item.label,
        items: item.children.map((child) => ({
          label: child.label,
          href: child.href,
          external: child.external,
        })),
      };
    }

    return {
      label: item.label,
      href: item.href,
      external: item.external,
    };
  });
}

function renderLink(item: TopBarLink, className: string) {
  return (
    <a
      href={item.href}
      className={className}
      target={item.external ? "_blank" : undefined}
      rel={item.external ? "noreferrer noopener" : undefined}
    >
      {item.label}
    </a>
  );
}

export function TopBar({
  surface,
  logo,
  items,
  searchTrigger,
  versionSelector,
  mobileMenuTrigger,
  className,
}: TopBarProps) {
  const resolvedItems = items ?? mapTopNavItems(surface?.topNav ?? []);

  return (
    <header className={`docsfn-topbar ${className || ""}`}>
      <div className="docsfn-topbar-container">
        {logo ? <div className="docsfn-topbar-logo">{logo}</div> : null}

        <nav className="docsfn-topbar-nav" aria-label="Main navigation">
          {resolvedItems.map((item, index) => {
            if (isDropdown(item)) {
              return (
                <DropdownMenu key={`${item.label}:${index}`}>
                  <DropdownMenuTrigger className="docsfn-topbar-dropdown-trigger">
                    {item.label}
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path
                        d="M3 5L6 8L9 5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="docsfn-topbar-dropdown-content">
                    {item.items.map((subItem, subIndex) => (
                      <DropdownMenuItem key={`${subItem.label}:${subIndex}`}>
                        {renderLink(subItem, "docsfn-topbar-dropdown-item")}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              );
            }

            return (
              <React.Fragment key={`${item.label}:${index}`}>
                {renderLink(item, "docsfn-topbar-link")}
              </React.Fragment>
            );
          })}
        </nav>

        <div className="docsfn-topbar-actions">
          {searchTrigger}
          {versionSelector}
          {mobileMenuTrigger}
        </div>
      </div>
    </header>
  );
}
