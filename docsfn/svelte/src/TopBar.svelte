<script lang="ts">
  import type { DocsTopNavItem } from "@docsfn/core/browser";
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
  } from "@uifn/svelte";
  import type { DocsPageSurface } from "./DocsLayout.svelte";

  export interface TopBarLink {
    label: string;
    href: string;
    external?: boolean;
  }

  export interface TopBarDropdown {
    label: string;
    items: TopBarLink[];
  }

  export type TopBarItem = TopBarLink | TopBarDropdown;

  export let surface: DocsPageSurface | undefined = undefined;
  export let logo: any = undefined;
  export let items: TopBarItem[] | undefined = undefined;
  export let searchTrigger: any = undefined;
  export let versionSelector: any = undefined;
  export let mobileMenuTrigger: any = undefined;

  function mapTopNavItems(topNav: DocsTopNavItem[]): TopBarItem[] {
    return topNav.map((item) => {
      if (Array.isArray(item.children) && item.children.length > 0) {
        return {
          label: item.label,
          items: item.children.map((child) => ({
            label: child.label,
            href: child.href,
            external: child.external,
          })),
        };
      }

      return {
        label: item.label,
        href: item.href,
        external: item.external,
      };
    });
  }

  function isDropdown(item: TopBarItem): item is TopBarDropdown {
    return "items" in item;
  }

  $: resolvedItems = items ?? mapTopNavItems(surface?.topNav ?? []);
</script>

<header class="docsfn-topbar">
  <div class="docsfn-topbar-container">
    <!-- Logo -->
    {#if logo}
      <div class="docsfn-topbar-logo">
        <svelte:component this={logo} />
      </div>
    {/if}

    <!-- Desktop Navigation -->
    <nav class="docsfn-topbar-nav" aria-label="Main navigation">
      {#each resolvedItems as item, index (`${item.label}:${index}`)}
        {#if isDropdown(item)}
          <DropdownMenu>
            <DropdownMenuTrigger class="docsfn-topbar-dropdown-trigger">
              {item.label}
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M3 5L6 8L9 5"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </DropdownMenuTrigger>
            <DropdownMenuContent class="docsfn-topbar-dropdown-content">
              {#each item.items as subItem, subIndex (`${subItem.label}:${subIndex}`)}
                <DropdownMenuItem>
                  <a
                    href={subItem.href}
                    class="docsfn-topbar-dropdown-item"
                    target={subItem.external ? "_blank" : undefined}
                    rel={subItem.external ? "noreferrer noopener" : undefined}
                  >
                    {subItem.label}
                  </a>
                </DropdownMenuItem>
              {/each}
            </DropdownMenuContent>
          </DropdownMenu>
        {:else}
          <a
            href={item.href}
            class="docsfn-topbar-link"
            target={item.external ? "_blank" : undefined}
            rel={item.external ? "noreferrer noopener" : undefined}
          >
            {item.label}
          </a>
        {/if}
      {/each}
    </nav>

    <!-- Right side actions -->
    <div class="docsfn-topbar-actions">
      {#if searchTrigger}
        <svelte:component this={searchTrigger} />
      {/if}
      {#if versionSelector}
        <svelte:component this={versionSelector} />
      {/if}
      {#if mobileMenuTrigger}
        <svelte:component this={mobileMenuTrigger} />
      {/if}
    </div>
  </div>
</header>
