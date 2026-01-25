import React from 'react';

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface BreadcrumbsProps {
  items: BreadcrumbItem[];
  separator?: React.ReactNode;
  className?: string;
}

export function Breadcrumbs({ items, separator, className }: BreadcrumbsProps) {
  if (items.length === 0) {
    return null;
  }

  const defaultSeparator = (
    <svg 
      width="16" 
      height="16" 
      viewBox="0 0 16 16" 
      fill="none"
      aria-hidden="true"
      className="docsfn-breadcrumb-separator"
    >
      <path 
        d="M6 4L10 8L6 12" 
        stroke="currentColor" 
        strokeWidth="1.5" 
        strokeLinecap="round" 
        strokeLinejoin="round"
      />
    </svg>
  );

  return (
    <nav 
      className={`docsfn-breadcrumbs ${className || ''}`}
      aria-label="Breadcrumb"
    >
      <ol className="docsfn-breadcrumbs-list">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          
          return (
            <li key={index} className="docsfn-breadcrumb-item">
              {item.href && !isLast ? (
                <a 
                  href={item.href} 
                  className="docsfn-breadcrumb-link"
                >
                  {item.label}
                </a>
              ) : (
                <span 
                  className="docsfn-breadcrumb-current"
                  aria-current={isLast ? 'page' : undefined}
                >
                  {item.label}
                </span>
              )}
              
              {!isLast && (
                <span className="docsfn-breadcrumb-separator-wrapper">
                  {separator || defaultSeparator}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
