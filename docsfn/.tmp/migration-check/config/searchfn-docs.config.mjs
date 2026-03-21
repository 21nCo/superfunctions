export default {
  "schemaVersion": 1,
  "site": {
    "title": "SearchFn Docs",
    "basePath": "/docs",
    "canonicalUrl": "https://example.com"
  },
  "compat": {
    "preset": "fumadocs-v15"
  },
  "content": {
    "root": "/Users/serro/Documents/dev/n/superfunctions/docsfn/test-fixtures/repo/searchfn-docs",
    "docsDir": "content/docs",
    "pagesDir": "pages",
    "blogDir": "blog",
    "apiDir": "api",
    "assetsDir": "public",
    "metaFileName": "meta.json"
  },
  "search": {
    "enabled": true,
    "scopes": [
      "docs",
      "api",
      "blog"
    ],
    "bodyIndexing": "summary"
  },
  "auth": {
    "enabled": false,
    "mode": "public"
  },
  "analytics": {
    "enabled": false,
    "provider": "watchfn",
    "respectDnt": true
  }
};
