<script lang="ts">
  import { invalidate } from '$app/navigation';
  import { ButtonIcon, ButtonLabel, ButtonRoot } from '@uifn/components-svelte/button';
  import ConsoleIcon from '$lib/components/ConsoleIcon.svelte';
  import { openSafeAdminDownload } from '$lib/components/admin-api';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import StatePanel from '$lib/components/StatePanel.svelte';
  import { onMount } from 'svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  let wrap = $state(true);
  let following = $state(false);
  let refreshing = $state(false);

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      await invalidate(data.dependencyKey);
    } finally {
      refreshing = false;
    }
  }

  function download() {
    openSafeAdminDownload(data.downloadHref);
  }

  onMount(() => {
    const timer = window.setInterval(() => {
      if (following && document.visibilityState === 'visible') void refresh();
    }, data.followIntervalMs);
    return () => window.clearInterval(timer);
  });
</script>

<PageHeader eyebrow={`CiFn run ${data.runId.slice(0, 10)}`} title={`${data.jobKey} logs`} description="Redacted log output provided by the CiFn and WatchFn administration contract." backHref={`/modules/cifn/runs/${encodeURIComponent(data.runId)}`}>
  {#snippet actions()}
    {#if data.followAvailable}
      <ButtonRoot variant="outline" pressed={following} onclick={() => (following = !following)}>
        <ButtonIcon><ConsoleIcon name={following ? 'pause' : 'activity'} /></ButtonIcon>
        <ButtonLabel>{following ? 'Pause follow' : 'Follow logs'}</ButtonLabel>
      </ButtonRoot>
    {/if}
    <ButtonRoot variant="outline" disabled={refreshing} onclick={() => void refresh()}>
      <ButtonIcon><ConsoleIcon name="refresh" /></ButtonIcon>
      <ButtonLabel>{refreshing ? 'Refreshing…' : 'Refresh'}</ButtonLabel>
    </ButtonRoot>
    {#if data.downloadHref}
      <ButtonRoot variant="outline" onclick={download}>
        <ButtonIcon><ConsoleIcon name="download" /></ButtonIcon><ButtonLabel>Download logs</ButtonLabel>
      </ButtonRoot>
    {/if}
    <ButtonRoot variant="outline" pressed={wrap} onclick={() => (wrap = !wrap)}>
      <ButtonIcon><ConsoleIcon name="terminal" /></ButtonIcon><ButtonLabel>{wrap ? 'Disable wrap' : 'Wrap lines'}</ButtonLabel>
    </ButtonRoot>
  {/snippet}
</PageHeader>

{#if data.loadError?.status === 403}
  <StatePanel kind="forbidden" error={data.loadError} />
{:else if data.loadError}
  <StatePanel kind="error" error={data.loadError} actionLabel="Retry" onAction={() => void refresh()} />
{:else}
  <div class="log-console" class:log-console--nowrap={!wrap} role="log" aria-label={`${data.jobKey} log output`} aria-live={following ? 'polite' : 'off'}>
    <div class="log-console__toolbar">
      <span class="log-console__lights" aria-hidden="true"><i></i><i></i><i></i></span>
      <code>{data.jobKey}</code>
      <span>{data.lines.length} lines{#if following} · following{/if}</span>
    </div>
    {#if data.lines.length === 0}
      <div class="log-console__empty">No log lines have been recorded for this job.</div>
    {:else}
      <ol>
        {#each data.lines as line, index (`${line.timestamp}-${index}`)}
          <li><span>{index + 1}</span><time>{line.timestamp ?? ''}</time>{#if line.stepKey}<em>{line.stepKey}</em>{/if}<code>{line.line}</code></li>
        {/each}
      </ol>
    {/if}
  </div>
{/if}
