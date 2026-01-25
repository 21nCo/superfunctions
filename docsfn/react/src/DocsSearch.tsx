import React, { useState, useEffect, useRef } from 'react';
import { InMemorySearchFn } from 'searchfn';
import {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
} from '@uifn/react';
import { ScrollArea } from '@uifn/react';

export interface DocsSearchProps {
  searchIndex: any; // Snapshot object
  placeholder?: string;
}

export function DocsSearch({ searchIndex, placeholder = 'Search docs...' }: DocsSearchProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const engineRef = useRef<InMemorySearchFn | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // ⌘K keyboard shortcut to open
  useEffect(() =&gt; {
    const handleKeydown = (e: KeyboardEvent) =&gt; {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeydown);
    return () =&gt; window.removeEventListener('keydown', handleKeydown);
  }, []);

  // Initialize search engine from snapshot
  useEffect(() =&gt; {
    if (searchIndex && !engineRef.current) {
      const engine = new InMemorySearchFn({
        fields: ['title', 'description', 'headings', 'tags', 'body']
      });
      engine.importSnapshot(searchIndex);
      engineRef.current = engine;
    }
  }, [searchIndex]);

  // Search for results when query changes
  useEffect(() =&gt; {
    if (!query || !engineRef.current) {
      setResults([]);
      setSelectedIndex(0);
      return;
    }
    const hits = engineRef.current.searchDetailed(query, { limit: 10, includeStored: true });
    setResults(hits);
    setSelectedIndex(0);
  }, [query]);

  // Focus input when dialog opens
  useEffect(() =&gt; {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  // Keyboard navigation for results
  const handleKeyDown = (e: React.KeyboardEvent) =&gt; {
    if (results.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) =&gt; Math.min(prev + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) =&gt; Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && results[selectedIndex]) {
      e.preventDefault();
      // Navigate to the selected result
      window.location.href = results[selectedIndex].document.path;
      setIsOpen(false);
    }
  };

  const handleResultClick = (path: string) =&gt; {
    window.location.href = path;
    setIsOpen(false);
  };

  const handleOpenChange = (open: boolean) =&gt; {
    setIsOpen(open);
    if (!open) {
      setQuery('');
      setResults([]);
      setSelectedIndex(0);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <button 
        className="docsfn-search-trigger" 
        onClick={() =&gt; setIsOpen(true)}
        aria-label="Search documentation"
      >
        <span className="docsfn-search-icon" aria-hidden="true">🔍</span>
        <span className="docsfn-search-placeholder">{placeholder}</span>
        <kbd className="docsfn-search-kbd">
          <span>⌘</span>
          <span>K</span>
        </kbd>
      </button>

      <DialogPortal>
        <DialogOverlay className="docsfn-search-overlay" />
        <DialogContent 
          className="docsfn-search-content"
          onKeyDown={handleKeyDown}
        >
          <div className="docsfn-search-header">
            <span className="docsfn-search-icon" aria-hidden="true">🔍</span>
            <input
              ref={inputRef}
              type="text"
              className="docsfn-search-input"
              placeholder={placeholder}
              value={query}
              onChange={(e) =&gt; setQuery(e.target.value)}
              aria-label="Search query"
            />
            {query && (
              <button 
                onClick={() =&gt; setQuery('')}
                className="docsfn-search-clear"
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>

          <ScrollArea className="docsfn-search-results">
            {results.length === 0 && query && (
              <div className="docsfn-search-empty">
                <p>No results found for &quot;{query}&quot;</p>
              </div>
            )}
            
            {results.length === 0 && !query && (
              <div className="docsfn-search-empty">
                <p>Start typing to search...</p>
              </div>
            )}

            {results.length &gt; 0 && (
              <div className="docsfn-search-results-list">
                {results.map((hit, index) =&gt; (
                  <button
                    key={hit.docId}
                    onClick={() =&gt; handleResultClick(hit.document.path)}
                    className={`docsfn-search-item ${index === selectedIndex ? 'selected' : ''}`}
                    data-selected={index === selectedIndex}
                  >
                    <div className="docsfn-search-item-header">
                      <span className="docsfn-search-item-kind">
                        {hit.document.kind === 'page' ? '📄' : hit.document.kind === 'post' ? '📝' : '🔧'}
                      </span>
                      <span className="docsfn-search-item-title">{hit.document.title}</span>
                    </div>
                    {hit.document.description && (
                      <p className="docsfn-search-item-desc">{hit.document.description}</p>
                    )}
                    <div className="docsfn-search-item-footer">
                      <span className="docsfn-search-item-path">{hit.document.path}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </ScrollArea>

          <div className="docsfn-search-footer">
            <div className="docsfn-search-commands">
              <kbd>↑↓</kbd> Navigate
              <kbd>↵</kbd> Select
              <kbd>Esc</kbd> Close
            </div>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
