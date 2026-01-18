import React from 'react';
import Markdown from 'markdown-to-jsx';

export interface DocsContentProps {
  content: string; // raw markdown
}

export function DocsContent({ content }: DocsContentProps) {
  return (
    <div className="docsfn-content">
      <Markdown>{content}</Markdown>
    </div>
  );
}
