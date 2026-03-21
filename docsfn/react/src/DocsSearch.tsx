import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  createDocsSearchRuntime,
  maybeEmitAnalyticsEvent,
  type DocsAnalyticsEvent,
  type DocsSearchArtifact,
  type DocsSearchRuntime,
  type DocsSearchRuntimeResultItem,
  type DocsSearchScope,
} from "@docsfn/core";
import {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogContent,
} from "@uifn/react";
import { ScrollArea } from "@uifn/react";

type SearchScopeFilter = DocsSearchScope | "all";

export interface DocsSearchProps {
  searchArtifact?: DocsSearchArtifact;
  searchIndex?: DocsSearchArtifact;
  loadSearchArtifact?: () => Promise<DocsSearchArtifact>;
  placeholder?: string;
  initialScope?: SearchScopeFilter;
  scopes?: SearchScopeFilter[];
  analytics?: {
    enabled?: boolean;
    respectDnt?: boolean;
    route?: string;
    onEvent?: (event: DocsAnalyticsEvent) => void;
  };
}

function normalizeScopes(input?: SearchScopeFilter[]): SearchScopeFilter[] {
  if (!input || input.length === 0) {
    return ["all", "docs", "api", "blog"];
  }
  const unique = Array.from(new Set(input));
  return unique.sort((left, right) =>
    left.localeCompare(right, "en", { sensitivity: "variant", numeric: true })
  );
}

function createTimestamp(): string {
  return new Date().toISOString();
}

export function DocsSearch({
  searchArtifact,
  searchIndex,
  loadSearchArtifact,
  placeholder = "Search docs...",
  initialScope = "all",
  scopes: scopeInput,
  analytics,
}: DocsSearchProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DocsSearchRuntimeResultItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scope, setScope] = useState<SearchScopeFilter>(initialScope);
  const inputRef = useRef<HTMLInputElement>(null);
  const runtimeRef = useRef<DocsSearchRuntime | null>(null);
  const queryRequestRef = useRef(0);
  const supportedScopes = useMemo(() => normalizeScopes(scopeInput), [scopeInput]);

  useEffect(() => {
    runtimeRef.current = createDocsSearchRuntime({
      artifact: searchArtifact ?? searchIndex,
      loadArtifact: loadSearchArtifact,
    });
  }, [searchArtifact, searchIndex, loadSearchArtifact]);

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setIsOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, []);

  useEffect(() => {
    if (!isOpen || !inputRef.current) {
      return;
    }
    inputRef.current.focus();
  }, [isOpen]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !query.trim()) {
      setResults([]);
      setSelectedIndex(0);
      return;
    }

    const requestId = queryRequestRef.current + 1;
    queryRequestRef.current = requestId;
    void runtime
      .query({
        query,
        scope,
        limit: 10,
      })
      .then((nextResults) => {
        if (queryRequestRef.current !== requestId) {
          return;
        }
        setResults(nextResults);
        setSelectedIndex(0);

        maybeEmitAnalyticsEvent({
          enabled: Boolean(analytics?.enabled),
          respectDnt: analytics?.respectDnt ?? true,
          event: {
            name: "docs.search",
            timestamp: createTimestamp(),
            route: analytics?.route ?? window.location.pathname,
            searchScope: scope === "all" ? undefined : scope,
            resultCount: nextResults.length,
          },
          emit: (event) => analytics?.onEvent?.(event),
        });
      })
      .catch(() => {
        if (queryRequestRef.current !== requestId) {
          return;
        }
        setResults([]);
        setSelectedIndex(0);
      });
  }, [query, scope, analytics]);

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (!open) {
      setQuery("");
      setResults([]);
      setSelectedIndex(0);
    }
  };

  const handleResultClick = (result: DocsSearchRuntimeResultItem) => {
    maybeEmitAnalyticsEvent({
      enabled: Boolean(analytics?.enabled),
      respectDnt: analytics?.respectDnt ?? true,
      event: {
        name: "docs.search_result_click",
        timestamp: createTimestamp(),
        route: analytics?.route ?? window.location.pathname,
        searchScope: result.scope,
        targetUrl: result.path,
      },
      emit: (event) => analytics?.onEvent?.(event),
    });
    window.location.href = result.path;
    setIsOpen(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (results.length === 0) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((previous) => Math.min(previous + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((previous) => Math.max(previous - 1, 0));
    } else if (event.key === "Enter" && results[selectedIndex]) {
      event.preventDefault();
      handleResultClick(results[selectedIndex]);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <button
        className="docsfn-search-trigger"
        onClick={() => setIsOpen(true)}
        aria-label="Search documentation"
      >
        <span className="docsfn-search-icon" aria-hidden="true">
          🔍
        </span>
        <span className="docsfn-search-placeholder">{placeholder}</span>
        <kbd className="docsfn-search-kbd">
          <span>⌘</span>
          <span>K</span>
        </kbd>
      </button>

      <DialogPortal>
        <DialogOverlay className="docsfn-search-overlay" />
        <DialogContent className="docsfn-search-content" onKeyDown={handleKeyDown}>
          <div className="docsfn-search-header">
            <span className="docsfn-search-icon" aria-hidden="true">
              🔍
            </span>
            <input
              ref={inputRef}
              type="text"
              className="docsfn-search-input"
              placeholder={placeholder}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search query"
            />
            <select
              value={scope}
              onChange={(event) => setScope(event.target.value as SearchScopeFilter)}
              aria-label="Search scope"
            >
              {supportedScopes.map((option) => (
                <option value={option} key={option}>
                  {option}
                </option>
              ))}
            </select>
            {query ? (
              <button
                onClick={() => setQuery("")}
                className="docsfn-search-clear"
                aria-label="Clear search"
              >
                ✕
              </button>
            ) : null}
          </div>

          <ScrollArea className="docsfn-search-results">
            {results.length === 0 && query ? (
              <div className="docsfn-search-empty">
                <p>No results found for &quot;{query}&quot;</p>
              </div>
            ) : null}
            {results.length === 0 && !query ? (
              <div className="docsfn-search-empty">
                <p>Start typing to search...</p>
              </div>
            ) : null}
            {results.length > 0 ? (
              <div className="docsfn-search-results-list">
                {results.map((result, index) => (
                  <button
                    key={`${result.id}:${result.path}`}
                    onClick={() => handleResultClick(result)}
                    className={`docsfn-search-item ${index === selectedIndex ? "selected" : ""}`}
                    data-selected={index === selectedIndex}
                  >
                    <div className="docsfn-search-item-header">
                      <span className="docsfn-search-item-kind">
                        {result.kind === "page" ? "📄" : result.kind === "post" ? "📝" : "🔧"}
                      </span>
                      <span className="docsfn-search-item-title">{result.title}</span>
                    </div>
                    {result.summary ? (
                      <p className="docsfn-search-item-desc">{result.summary}</p>
                    ) : null}
                    <div className="docsfn-search-item-footer">
                      <span className="docsfn-search-item-path">{result.path}</span>
                    </div>
                  </button>
                ))}
              </div>
            ) : null}
          </ScrollArea>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
