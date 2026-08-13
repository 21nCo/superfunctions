<script lang="ts">
  import { goto } from '$app/navigation';
  import { ButtonIcon, ButtonLabel, ButtonRoot } from '@uifn/components-svelte/button';
  import { InputRoot } from '@uifn/components-svelte/input';
  import ActionButton from './ActionButton.svelte';
  import ConsoleIcon from './ConsoleIcon.svelte';
  import PageHeader from './PageHeader.svelte';
  import ResourceTable from './ResourceTable.svelte';
  import StatePanel from './StatePanel.svelte';
  import type { AdminErrorViewModel, ResourceListViewModel } from './view-models';

  let {
    view,
    loadError,
    initialQuery = '',
  }: { view?: ResourceListViewModel; loadError?: AdminErrorViewModel; initialQuery?: string } = $props();
  let query = $state('');
  $effect(() => { query = initialQuery; });

  function search() {
    const url = new URL(window.location.href);
    if (query.trim()) url.searchParams.set('q', query.trim());
    else url.searchParams.delete('q');
    void goto(`${url.pathname}${url.search}`);
  }
</script>

{#if !view}
  <PageHeader eyebrow="Resource registry" title="Resource unavailable" backHref="/" />
  <StatePanel kind="not-found" error={loadError} actionHref="/" actionLabel="Return to overview" />
{:else}
  <PageHeader
    eyebrow={view.resource.sourceModuleId && view.resource.sourceModuleId !== view.module.id ? `${view.module.name} / ${view.resource.sourceModuleId}` : view.module.name}
    title={view.resource.pluralLabel ?? view.resource.label}
    description={view.resource.description}
    backHref={view.module.href}
  >
    {#snippet actions()}
      {#if view.resource.createAction}<ActionButton action={view.resource.createAction} />{/if}
    {/snippet}
  </PageHeader>

  {#if loadError?.status === 403}
    <StatePanel kind="forbidden" error={loadError} />
  {:else if loadError}
    <StatePanel kind="error" error={loadError} actionHref={view.resource.href} actionLabel="Retry" />
  {:else}
    <form class="resource-toolbar" onsubmit={(event) => { event.preventDefault(); search(); }}>
      <div class="resource-toolbar__search">
        <ConsoleIcon name="search" />
        <InputRoot value={query} oninput={(event: Event) => (query = (event.currentTarget as HTMLInputElement).value)} name="q" placeholder={`Search ${view.resource.pluralLabel ?? view.resource.label.toLowerCase()}…`} aria-label="Search resources" />
      </div>
      <ButtonRoot type="submit" variant="outline"><ButtonLabel>Search</ButtonLabel></ButtonRoot>
      <span class="resource-toolbar__count">{view.total ?? view.rows.length} total</span>
    </form>

    <ResourceTable caption={`${view.resource.pluralLabel ?? view.resource.label} in the active operator scope.`} columns={view.columns} rows={view.rows} />

    {#if view.nextCursor}
      <div class="pagination-bar">
        <span>More resources are available.</span>
        <ButtonRoot variant="outline" onclick={() => {
          const url = new URL(window.location.href);
          url.searchParams.set('cursor', view!.nextCursor!);
          void goto(`${url.pathname}${url.search}`);
        }}>
          <ButtonLabel>Load next page</ButtonLabel><ButtonIcon><ConsoleIcon name="arrow-right" /></ButtonIcon>
        </ButtonRoot>
      </div>
    {/if}
  {/if}
{/if}
