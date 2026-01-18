import React, { useState, useEffect, useRef } from 'react';
import { InMemorySearchFn } from 'searchfn';

export interface DocsSearchProps {
  searchIndex: any; // Snapshot object
  placeholder?: string;
}

export function DocsSearch({ searchIndex, placeholder = 'Search docs...' }: DocsSearchProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const engineRef = useRef<InMemorySearchFn | null>(null);

  useEffect(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsOpen(true);
      }
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, []);

  useEffect(() => {
    if (searchIndex && !engineRef.current) {
      const engine = new InMemorySearchFn({
        fields: ['title', 'description', 'headings', 'tags', 'body']
      });
      engine.importSnapshot(searchIndex);
      engineRef.current = engine;
    }
  }, [searchIndex]);

  useEffect(() => {
    if (!query || !engineRef.current) {
      setResults([]);
      return;
    }
    const hits = engineRef.current.searchDetailed(query, { limit: 5, includeStored: true });
    setResults(hits);
  }, [query]);

  if (!isOpen) {
    return (
      <button 
        className="docsfn-search-trigger" 
        onClick={() => setIsOpen(true)}
      >
        <span className="icon">🔍</span>
        <span className="placeholder">{placeholder}</span>
        <span className="shortcut">⌘K</span>
      </button>
    );
  }

  return (
    <div className="docsfn-search-overlay" onClick={() => setIsOpen(false)}>
      <div className="docsfn-search-modal" onClick={e => e.stopPropagation()}>
        <header className="docsfn-search-header">
          <input
            autoFocus
            type="text"
            className="docsfn-search-input"
            placeholder={placeholder}
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </header>
        <div className="docsfn-search-results">
          {results.length === 0 && query && (
            <div className="docsfn-search-empty">No results found.</div>
          )}
          {results.map((hit) => (
            <a 
              key={hit.docId} 
              href={hit.document.path}
              className="docsfn-search-item"
              onClick={() => setIsOpen(false)}
            >
              <div className="docsfn-search-item-title">{hit.document.title}</div>
              {hit.document.description && (
                <div className="docsfn-search-item-desc">{hit.document.description}</div>
              )}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
