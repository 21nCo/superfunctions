<script lang="ts">
  import DocsContent from "@site/docs-content";
  import type { PageData } from "./$types";

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
  const collectionLabel = $derived(data.collection?.label ?? "Changelog");
</script>

<svelte:head>
  <title>{data.post.title} - {data.siteTitle}</title>
  {#if data.post.excerpt ?? data.post.summary}
    <meta name="description" content={data.post.excerpt ?? data.post.summary ?? ""} />
  {/if}
</svelte:head>

<article class="changelog-post docsfn-layout">
  <a class="changelog-post-back" href="/changelog">{collectionLabel}</a>

  <header class="changelog-post-header">
    <p class="changelog-post-date">
      <time datetime={data.post.date}>{data.post.date}</time>
    </p>
    <h1>{data.post.title}</h1>
    {#if data.post.tags?.length}
      <ul class="changelog-post-tags">
        {#each data.post.tags as tag (tag)}
          <li>{tag}</li>
        {/each}
      </ul>
    {/if}
  </header>

  <div class="changelog-post-body">
    <DocsContent compiled={data.compiled} />
  </div>
</article>

<style>
  .changelog-post {
    padding-block: 2rem 3rem;
    max-width: 48rem;
  }

  .changelog-post-back {
    display: inline-flex;
    margin-bottom: 1.5rem;
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--docsfn-color-primary, #2563eb);
    text-decoration: none;
  }

  .changelog-post-back:hover {
    text-decoration: underline;
  }

  .changelog-post-date {
    margin: 0 0 0.5rem;
    font-size: 0.9rem;
    color: var(--docsfn-color-muted, #64748b);
  }

  .changelog-post-header h1 {
    margin: 0;
    font-size: 2rem;
    color: var(--docsfn-color-fg, #0f172a);
  }

  .changelog-post-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 1rem 0 0;
    padding: 0;
    list-style: none;
  }

  .changelog-post-tags li {
    font-size: 0.75rem;
    padding: 0.2rem 0.5rem;
    border-radius: 999px;
    background: var(--docsfn-color-border, #e2e8f0);
    color: var(--docsfn-color-fg, #0f172a);
  }

  .changelog-post-body {
    margin-top: 2rem;
  }
</style>
