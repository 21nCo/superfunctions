import React from 'react';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@uifn/react';

export interface TopBarLink {
  label: string;
  href: string;
}

export interface TopBarDropdown {
  label: string;
  items: TopBarLink[];
}

export type TopBarItem = TopBarLink | TopBarDropdown;

export interface TopBarProps {
  logo?: React.ReactNode;
  items?: TopBarItem[];
  searchTrigger?: React.ReactNode;
  versionSelector?: React.ReactNode;
  mobileMenuTrigger?: React.ReactNode;
  className?: string;
}

function isDropdown(item: TopBarItem): item is TopBarDropdown {
  return 'items' in item;
}

export function TopBar({ 
  logo, 
  items = [], 
  searchTrigger, 
  versionSelector,
  mobileMenuTrigger,
  className 
}: TopBarProps) {
  return (
    <header className={`docsfn-topbar ${className || ''}`}>
      <div className="docsfn-topbar-container">
        {/* Logo */}
        {logo && (
          <div className="docsfn-topbar-logo">
            {logo}
          </div>
        )}

        {/* Desktop Navigation */}
        <nav className="docsfn-topbar-nav" aria-label="Main navigation">
          {items.map((item, index) => {
            if (isDropdown(item)) {
              return (
                <DropdownMenu key={index}>
                  <DropdownMenuTrigger className="docsfn-topbar-dropdown-trigger">
                    {item.label}
                    <svg 
                      width="12" 
                      height="12" 
                      viewBox="0 0 12 12" 
                      fill="none"
                      aria-hidden="true"
                    >
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
                      <DropdownMenuItem key={subIndex}>
                        <a href={subItem.href} className="docsfn-topbar-dropdown-item">
                          {subItem.label}
                        </a>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              );
            }

            return (
              <a 
                key={index}
                href={item.href} 
                className="docsfn-topbar-link"
              >
                {item.label}
              </a>
            );
          })}
        </nav>

        {/* Right side actions */}
        <div className="docsfn-topbar-actions">
          {searchTrigger}
          {versionSelector}
          {mobileMenuTrigger}
        </div>
      </div>
    </header>
  );
}
