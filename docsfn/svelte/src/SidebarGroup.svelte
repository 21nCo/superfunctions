<script lang="ts">
  import type { SidebarItem } from "@docsfn/core/browser";

  export let item: SidebarItem;
  export let activePath: string | undefined = undefined;
  export let depth = 0;

  function hasActiveLink(item: SidebarItem, activePath?: string): boolean {
    if (item.type === 'link' && item.link === activePath) {
      return true;
    }
    if (item.type === 'group' && item.items) {
      return item.items.some(child => hasActiveLink(child, activePath));
    }
    return false;
  }

  $: hasActiveChild = hasActiveLink(item, activePath);
  $: isActive = item.type === 'link' && activePath === item.link;
</script>

{#if item.type === 'separator'}
  <hr class="docsfn-sidebar-separator" />
{:else if item.type === "group"}
  <details
    class="docsfn-sidebar-group"
    data-depth={depth}
    open={item.expanded === true || hasActiveChild}
  >
    <summary class="docsfn-sidebar-group-trigger">
      <span class="docsfn-sidebar-group-text">{item.text}</span>
      <span class="docsfn-sidebar-group-icon" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path
            d="M4 3L7 6L4 9"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </span>
    </summary>

    <div class="docsfn-sidebar-group-content">
      {#if item.items}
        {#each item.items as sub, i (i)}
          <svelte:self item={sub} activePath={activePath} depth={depth + 1} />
        {/each}
      {/if}
    </div>
  </details>
{:else if item.type === 'link'}
  <a 
    href={item.link} 
    class="docsfn-sidebar-link {isActive ? 'active' : ''}"
    data-active={isActive}
    data-depth={depth}
    aria-current={isActive ? 'page' : undefined}
  >
    {item.text}
  </a>
{/if}
