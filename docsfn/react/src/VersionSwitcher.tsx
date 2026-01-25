import React from 'react';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@uifn/react';
import type { Version } from '@docsfn/core';

export interface VersionSwitcherProps {
  versions: Version[];
  currentVersion: string;
  onVersionChange?: (versionSlug: string) => void;
  className?: string;
}

export function VersionSwitcher({ 
  versions, 
  currentVersion, 
  onVersionChange,
  className 
}: VersionSwitcherProps) {
  const current = versions.find(v => v.slug === currentVersion);

  const handleChange = (versionSlug: string) => {
    if (onVersionChange) {
      onVersionChange(versionSlug);
    } else {
      // Default behavior: Navigate to same page in different version
      const currentPath = window.location.pathname;
      // Replace version in path (e.g., /v2/docs/intro -> /v3/docs/intro)
      const newPath = currentPath.replace(
        new RegExp(`^/(${versions.map(v => v.slug).join('|')})/`),
        `/${versionSlug}/`
      );
      window.location.href = newPath;
    }
  };

  if (versions.length <= 1) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={`docsfn-version-switcher-trigger ${className || ''}`}>
        <span className="docsfn-version-label">{current?.label || currentVersion}</span>
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
      <DropdownMenuContent className="docsfn-version-switcher-content">
        {versions.map((version) => (
          <DropdownMenuItem 
            key={version.slug}
            onClick={() => handleChange(version.slug)}
            className={`docsfn-version-item ${version.slug === currentVersion ? 'active' : ''}`}
            data-active={version.slug === currentVersion}
          >
            <span className="docsfn-version-item-label">{version.label}</span>
            {version.isDefault && (
              <span className="docsfn-version-badge">Default</span>
            )}
            {version.slug === currentVersion && (
              <svg 
                width="16" 
                height="16" 
                viewBox="0 0 16 16" 
                fill="none"
                className="docsfn-version-check"
                aria-hidden="true"
              >
                <path 
                  d="M13 4L6 11L3 8" 
                  stroke="currentColor" 
                  strokeWidth="2" 
                  strokeLinecap="round" 
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
