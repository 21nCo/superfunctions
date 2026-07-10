<script lang="ts">
  import type { PageData } from "./$types";

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
  const title = $derived(data.collection?.label ?? "Changelog");
</script>

<svelte:head>
  <title>{title} - {data.source.siteTitle}</title>
  <meta name="description" content="Product updates and release notes." />
</svelte:head>

<div class="changelog-list docsfn-layout">
  <header class="changelog-list-header">
    <h1>{title}</h1>
    <p class="changelog-list-intro">Product updates and release notes.</p>
  </header>

  {#if data.posts.length === 0}
    <p class="changelog-list-empty">No changelog entries yet.</p>
  {:else}
    <ol class="changelog-list-items">
      {#each data.posts as post (post.id)}
        <li>
          <a class="changelog-list-card" href={post.path}>
            <span class="changelog-list-date">
              <time datetime={post.date}>{post.date}</time>
            </span>
            <span class="changelog-list-title">{post.title}</span>
            {#if post.excerpt ?? post.summary}
              <p class="changelog-list-excerpt">{post.excerpt ?? post.summary}</p>
            {/if}
          </a>
        </li>
      {/each}
    </ol>
  {/if}
</div>

<style>
  .changelog-list {
    padding-block: 2rem 3rem;
  }

  .changelog-list-header h1 {
    margin: 0 0 0.5rem;
    font-size: 2rem;
    color: var(--docsfn-color-fg, #0f172a);
  }

  .changelog-list-intro,
  .changelog-list-empty {
    margin: 0;
    color: var(--docsfn-color-muted, #64748b);
  }

  .changelog-list-empty {
    margin-top: 2rem;
  }

  .changelog-list-items {
    list-style: none;
    margin: 2rem 0 0;
    padding: 0;
    display: grid;
    gap: 1rem;
  }

  .changelog-list-card {
    display: grid;
    gap: 0.4rem;
    padding: 1rem 1.25rem;
    border-radius: 0.5rem;
    border: 1px solid var(--docsfn-color-border, #e2e8f0);
    text-decoration: none;
    color: inherit;
    background: var(--docsfn-color-surface, #fff);
    transition:
      border-color 0.15s ease,
      box-shadow 0.15s ease;
  }

  .changelog-list-card:hover {
    border-color: var(--docsfn-color-primary, #2563eb);
    box-shadow: 0 2px 12px rgb(37 99 235 / 0.1);
  }

  .changelog-list-date {
    font-size: 0.8rem;
    color: var(--docsfn-color-muted, #64748b);
  }

  .changelog-list-title {
    font-weight: 600;
    font-size: 1.05rem;
    color: var(--docsfn-color-fg, #0f172a);
  }

  .changelog-list-excerpt {
    margin: 0;
    font-size: 0.9rem;
    line-height: 1.5;
    color: var(--docsfn-color-muted, #64748b);
  }
</style>
