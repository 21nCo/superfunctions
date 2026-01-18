import { DocsManifest } from './types';
import { InMemorySearchFn } from 'searchfn';

export async function buildSearchIndex(manifest: DocsManifest) {
  const search = new InMemorySearchFn({
    fields: ['title', 'description', 'headings', 'tags', 'body'],
    pipeline: {
      enableEdgeNGrams: true, // For autocomplete
      edgeNGramMinLength: 3,
      stopWords: new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for'])
    }
  });

  // Index Pages
  for (const page of Object.values(manifest.pages)) {
    const headingTexts = page.headings.map(h => h.text).join(' ');
    
    // We add the whole page as one doc for now. 
    // Ideally we might split by heading but that's V2.
    search.add({
      id: page.id,
      fields: {
        title: page.title,
        description: page.description || '',
        headings: headingTexts,
        body: page.body, // This might be large, careful
        tags: ''
      },
      store: {
        kind: 'page',
        path: page.path,
        title: page.title
      }
    });
  }

  // Index Posts
  for (const post of Object.values(manifest.posts)) {
    search.add({
      id: post.id,
      fields: {
        title: post.title,
        description: post.excerpt || '',
        headings: '',
        body: post.body,
        tags: post.tags.join(' ')
      },
      store: {
        kind: 'post',
        path: post.path,
        title: post.title
      }
    });
  }

  // Export snapshot
  const snapshot = await search.exportSnapshot();
  return snapshot;
}
