import React, { useEffect } from 'react';

export interface PaginationProps {
  prevPage?: {
    title: string;
    path: string;
  };
  nextPage?: {
    title: string;
    path: string;
  };
  sectionContext?: string;
  className?: string;
}

export function Pagination({ prevPage, nextPage, sectionContext, className }: PaginationProps) {
  // Keyboard shortcuts for prev/next navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Alt + Arrow Left = Previous page
      if (e.altKey && e.key === 'ArrowLeft' && prevPage) {
        window.location.href = prevPage.path;
      }
      // Alt + Arrow Right = Next page
      if (e.altKey && e.key === 'ArrowRight' && nextPage) {
        window.location.href = nextPage.path;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [prevPage, nextPage]);

  if (!prevPage && !nextPage) {
    return null;
  }

  return (
    <nav 
      className={`docsfn-pagination ${className || ''}`}
      aria-label="Page navigation"
    >
      {sectionContext && (
        <div className="docsfn-pagination-context">
          {sectionContext}
        </div>
      )}
      
      <div className="docsfn-pagination-links">
        {prevPage ? (
          <a 
            href={prevPage.path} 
            className="docsfn-pagination-prev"
            rel="prev"
          >
            <svg 
              width="16" 
              height="16" 
              viewBox="0 0 16 16" 
              fill="none"
              aria-hidden="true"
            >
              <path 
                d="M10 12L6 8L10 4" 
                stroke="currentColor" 
                strokeWidth="2" 
                strokeLinecap="round" 
                strokeLinejoin="round"
              />
            </svg>
            <div>
              <div className="docsfn-pagination-label">Previous</div>
              <div className="docsfn-pagination-title">{prevPage.title}</div>
            </div>
          </a>
        ) : (
          <div className="docsfn-pagination-spacer" />
        )}

        {nextPage ? (
          <a 
            href={nextPage.path} 
            className="docsfn-pagination-next"
            rel="next"
          >
            <div>
              <div className="docsfn-pagination-label">Next</div>
              <div className="docsfn-pagination-title">{nextPage.title}</div>
            </div>
            <svg 
              width="16" 
              height="16" 
              viewBox="0 0 16 16" 
              fill="none"
              aria-hidden="true"
            >
              <path 
                d="M6 4L10 8L6 12" 
                stroke="currentColor" 
                strokeWidth="2" 
                strokeLinecap="round" 
                strokeLinejoin="round"
              />
            </svg>
          </a>
        ) : (
          <div className="docsfn-pagination-spacer" />
        )}
      </div>
    </nav>
  );
}
