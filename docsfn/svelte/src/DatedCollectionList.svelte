<script lang="ts">
  import type { BlogPost } from "@docsfn/core/browser";

  export interface DatedCollectionListProps {
    posts: BlogPost[];
    title?: string;
    description?: string;
    embedded?: boolean;
    emptyLabel?: string;
    ariaLabel?: string;
    getPostHref?: (post: BlogPost) => string;
  }

  export let posts: BlogPost[] = [];
  export let title = "Updates";
  export let description: string | undefined = undefined;
  export let embedded = false;
  export let emptyLabel = "No entries yet.";
  export let ariaLabel: string | undefined = undefined;
  export let getPostHref: ((post: BlogPost) => string) | undefined = undefined;

  $: resolvedAriaLabel = ariaLabel ?? title;
  $: showDescription = Boolean(description) && !embedded;
</script>

<section
  class="docsfn-dated-list docsfn-layout"
  class:docsfn-dated-list--embedded={embedded}
  aria-label={resolvedAriaLabel}
>
  <header class="docsfn-dated-list-header">
    <h1>{title}</h1>
    {#if showDescription}
      <p>{description}</p>
    {/if}
  </header>

  {#if posts.length === 0}
    <p class="docsfn-dated-list-empty">{emptyLabel}</p>
  {:else}
    <ol class="docsfn-dated-list-items">
      {#each posts as post (post.id)}
        {@const href = getPostHref ? getPostHref(post) : post.path}
        <li>
          <a class="docsfn-dated-list-card" href={href}>
            <span class="docsfn-dated-list-date">
              <time datetime={post.date}>{post.date}</time>
            </span>
            <span class="docsfn-dated-list-title">{post.title}</span>
            {#if post.excerpt ?? post.summary}
              <p class="docsfn-dated-list-excerpt">{post.excerpt ?? post.summary}</p>
            {/if}
          </a>
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .docsfn-dated-list {
    padding-block: 2rem 3rem;
  }

  .docsfn-dated-list--embedded {
    padding-block: 0;
    background: transparent;
  }

  .docsfn-dated-list-header h1 {
    margin: 0 0 0.5rem;
    font-size: 2rem;
    color: var(--docsfn-color-fg, #0f172a);
  }

  .docsfn-dated-list--embedded .docsfn-dated-list-header h1 {
    font-size: 1.25rem;
  }

  .docsfn-dated-list-header p,
  .docsfn-dated-list-empty {
    margin: 0;
    color: var(--docsfn-color-muted, #64748b);
  }

  .docsfn-dated-list-empty {
    margin-top: 2rem;
  }

  .docsfn-dated-list-items {
    list-style: none;
    margin: 2rem 0 0;
    padding: 0;
    display: grid;
    gap: 1rem;
  }

  .docsfn-dated-list--embedded .docsfn-dated-list-items {
    margin-top: 1rem;
  }

  .docsfn-dated-list-card {
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

  .docsfn-dated-list-card:hover {
    border-color: var(--docsfn-color-primary, #2563eb);
    box-shadow: 0 2px 12px rgb(37 99 235 / 0.1);
  }

  .docsfn-dated-list-date {
    font-size: 0.8rem;
    color: var(--docsfn-color-muted, #64748b);
  }

  .docsfn-dated-list-title {
    font-weight: 600;
    font-size: 1.05rem;
    color: var(--docsfn-color-fg, #0f172a);
  }

  .docsfn-dated-list-excerpt {
    margin: 0;
    font-size: 0.9rem;
    line-height: 1.5;
    color: var(--docsfn-color-muted, #64748b);
  }
</style>
