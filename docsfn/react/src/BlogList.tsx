import React from 'react';
import type { BlogPost, DocsManifest } from '@docsfn/core';

export interface BlogListProps {
  posts: BlogPost[];
  selectedTag?: string;
  onTagClick?: (tag: string) => void;
}

export function BlogList({ posts, selectedTag, onTagClick }: BlogListProps) {
  // Sort by date descending
  const sortedPosts = [...posts].sort((a, b) => 
    new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  const filteredPosts = selectedTag
    ? sortedPosts.filter(post => post.tags.includes(selectedTag))
    : sortedPosts;

  // Get all unique tags
  const allTags = Array.from(
    new Set(posts.flatMap(post => post.tags))
  ).sort();

  return (
    <div className="docsfn-blog-list">
      {allTags.length > 0 && (
        <div className="docsfn-blog-tags">
          <button
            onClick={() => onTagClick?.('')}
            className={`docsfn-blog-tag ${!selectedTag ? 'active' : ''}`}
            data-active={!selectedTag}
          >
            All
          </button>
          {allTags.map(tag => (
            <button
              key={tag}
              onClick={() => onTagClick?.(tag)}
              className={`docsfn-blog-tag ${selectedTag === tag ? 'active' : ''}`}
              data-active={selectedTag === tag}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      <div className="docsfn-blog-posts">
        {filteredPosts.length === 0 ? (
          <p className="docsfn-blog-empty">No posts found.</p>
        ) : (
          filteredPosts.map(post => (
            <article key={post.id} className="docsfn-blog-post">
              <a href={post.path} className="docsfn-blog-post-link">
                <time className="docsfn-blog-post-date">
                  {new Date(post.date).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric'
                  })}
                </time>
                <h2 className="docsfn-blog-post-title">{post.title}</h2>
                {post.excerpt && (
                  <p className="docsfn-blog-post-excerpt">{post.excerpt}</p>
                )}
                {post.tags.length > 0 && (
                  <div className="docsfn-blog-post-tags">
                    {post.tags.map(tag => (
                      <span key={tag} className="docsfn-blog-post-tag">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </a>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
