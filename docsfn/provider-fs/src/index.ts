import { DocsContentProvider, RawContentEntry } from '@docsfn/core';
import fg from 'fast-glob';
import matter from 'gray-matter';
import fs from 'fs/promises';
import path from 'path';

export interface FsProviderOptions {
  root: string;
  docsDir?: string;
  blogDir?: string;
  apiDir?: string;
}

export class FsContentProvider implements DocsContentProvider {
  private options: FsProviderOptions;

  constructor(options: FsProviderOptions) {
    this.options = {
      docsDir: 'docs',
      blogDir: 'blog',
      apiDir: 'api',
      ...options
    };
  }

  async list(): Promise<RawContentEntry[]> {
    const entries: RawContentEntry[] = [];
    
    // Load Docs
    const docsPattern = path.join(this.options.root, this.options.docsDir!, '**/*.{md,mdx}');
    const docFiles = await fg(docsPattern);
    
    for (const file of docFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const { data, content: body } = matter(content);
      const relativePath = path.relative(path.join(this.options.root, this.options.docsDir!), file);
      
      entries.push({
        id: relativePath,
        kind: 'page',
        body,
        frontmatter: data,
        filepath: file
      });
    }

    // Load Blog
    if (this.options.blogDir) {
       const blogPattern = path.join(this.options.root, this.options.blogDir, '**/*.{md,mdx}');
       const blogFiles = await fg(blogPattern);
       
       for (const file of blogFiles) {
         const content = await fs.readFile(file, 'utf-8');
         const { data, content: body } = matter(content);
         const relativePath = path.relative(path.join(this.options.root, this.options.blogDir!), file);

         entries.push({
           id: relativePath,
           kind: 'post',
           body,
           frontmatter: data,
           filepath: file
         });
       }
    }

    // Load API
    if (this.options.apiDir) {
      const apiPattern = path.join(this.options.root, this.options.apiDir, '**/*.{json,yaml,yml}');
      const apiFiles = await fg(apiPattern);

      for (const file of apiFiles) {
        const content = await fs.readFile(file, 'utf-8');
        // APIs usually don't have frontmatter in the spec file itself in the same way,
        // but we can try parsing if it's there (unlikely for JSON).
        // For now, assume no frontmatter for API specs, or valid JSON/YAML.
        // We'll create a synthetic frontmatter based on filename.
        const id = path.relative(path.join(this.options.root, this.options.apiDir!), file);
        
        entries.push({
          id,
          kind: 'api',
          body: content,
          frontmatter: { title: path.basename(id) }, // Default title
          filepath: file
        });
      }
    }

    return entries;
  }
}
