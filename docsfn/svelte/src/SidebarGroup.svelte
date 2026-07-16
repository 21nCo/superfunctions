<script lang="ts">
  import type { SidebarItem } from "@docsfn/core/browser";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import SidebarIcon from "./SidebarIcon.svelte";

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

  let groupOpen =
    item.type === "group" &&
    (item.expanded === true || hasActiveLink(item, activePath));

  $: hasActiveChild = hasActiveLink(item, activePath);
  $: if (item.type === "group" && hasActiveChild) {
    groupOpen = true;
  }
  $: isActive = item.type === 'link' && activePath === item.link;
  $: isExternal = item.type === "link" && Boolean(item.link?.startsWith("http"));
</script>

{#if item.type === 'separator'}
  <hr class="docsfn-sidebar-separator" />
{:else if item.type === "group"}
  <details
    class="docsfn-sidebar-group"
    data-depth={depth}
    bind:open={groupOpen}
  >
    <summary class="docsfn-sidebar-group-trigger">
      {#if item.icon}
        <span class="docsfn-sidebar-item-icon"><SidebarIcon name={item.icon} /></span>
      {/if}
      <span class="docsfn-sidebar-group-text" title={item.description}>{item.text}</span>
      {#if item.badge}
        <span class="docsfn-sidebar-badge">{item.badge}</span>
      {/if}
      <span class="docsfn-sidebar-group-icon" aria-hidden="true">
        <ChevronRight size={13} strokeWidth={1.8} />
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
    title={item.description}
    target={isExternal ? "_blank" : undefined}
    rel={isExternal ? "noreferrer noopener" : undefined}
  >
    {#if item.icon}
      <span class="docsfn-sidebar-item-icon"><SidebarIcon name={item.icon} /></span>
    {/if}
    <span class="docsfn-sidebar-link-text">{item.text}</span>
    {#if item.badge}
      <span class="docsfn-sidebar-badge">{item.badge}</span>
    {/if}
    {#if isExternal}
      <ExternalLink size={12} strokeWidth={1.8} aria-hidden="true" />
    {/if}
  </a>
{/if}
