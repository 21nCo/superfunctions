import type { DocsManifest } from "./types";
// import { InMemorySearchFn } from 'searchfn'; // Temporarily disabled for testing

export async function buildSearchIndex(manifest: DocsManifest) {
  // TODO: Re-enable after resolving searchfn workspace linking
  // For now, return a minimal placeholder
  console.warn("Search index building temporarily disabled");
  return { docs: {}, index: {} };

  /* Temporarily disabled until searchfn workspace setup is resolved
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
        title: page.title,
        version: page.version // Include version for filtering
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
        title: post.title,
        version: post.version // Include version for filtering
      }
    });
  }

  // Export snapshot
  const snapshot = await search.exportSnapshot();
  return snapshot;
  */
}
