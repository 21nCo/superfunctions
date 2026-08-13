<script lang="ts">
  import { goto } from '$app/navigation';
  import { ButtonIcon, ButtonLabel, ButtonRoot } from '@uifn/components-svelte/button';
  import {
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRoot,
    TableRow,
    TableTable,
  } from '@uifn/components-svelte/table';
  import ActionButton from '$lib/components/ActionButton.svelte';
  import ConsoleIcon from '$lib/components/ConsoleIcon.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import StatePanel from '$lib/components/StatePanel.svelte';
  import StatusBadge from '$lib/components/StatusBadge.svelte';
  import { formatValue } from '$lib/components/view-models';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const statuses = ['', 'queued', 'running', 'success', 'failure', 'cancelled'];

  function setStatus(status: string) {
    const url = new URL(window.location.href);
    if (status) url.searchParams.set('status', status);
    else url.searchParams.delete('status');
    url.searchParams.delete('cursor');
    void goto(`${url.pathname}${url.search}`);
  }
</script>

{#if !data.module}
  <PageHeader eyebrow="Continuous integration" title="CiFn is not enabled" description="Only deploy-time enabled modules are visible in Super Console." />
  <StatePanel kind="not-found" error={data.loadError} actionHref="/" actionLabel="Return to overview" />
{:else}
  <PageHeader eyebrow="Continuous integration" title="Runs" description="Trigger and inspect CiFn pipelines, jobs, logs, and artifacts from the shared operator shell.">
    {#snippet actions()}
      {#each data.module.actions ?? [] as action (action.id)}<ActionButton {action} />{/each}
    {/snippet}
  </PageHeader>

  <div class="run-summary">
    <div><span>Visible runs</span><strong>{data.runs.length}</strong></div>
    <div><span>In progress</span><strong>{data.runs.filter((run) => ['queued', 'running'].includes(run.status)).length}</strong></div>
    <div><span>Failed</span><strong>{data.runs.filter((run) => run.status === 'failure').length}</strong></div>
    <div><span>Succeeded</span><strong>{data.runs.filter((run) => run.status === 'success').length}</strong></div>
  </div>

  <div class="filter-pills" aria-label="Filter runs by status">
    {#each statuses as status}
      <ButtonRoot variant={data.status === status ? 'secondary' : 'ghost'} size="sm" pressed={data.status === status} onclick={() => setStatus(status)}>
        <ButtonLabel>{status || 'All runs'}</ButtonLabel>
      </ButtonRoot>
    {/each}
  </div>

  {#if data.loadError?.status === 403}
    <StatePanel kind="forbidden" error={data.loadError} />
  {:else if data.loadError}
    <StatePanel kind="error" error={data.loadError} actionHref="/modules/cifn" actionLabel="Retry" />
  {:else if data.runs.length === 0}
    <StatePanel kind="empty" title="No CiFn runs" message="Trigger a workflow dispatch or connect a repository event to create the first run." />
  {:else}
    <TableRoot class="runs-table">
      <TableTable>
        <TableHeader><TableRow value="header"><TableHead value="run">Run</TableHead><TableHead value="repository">Repository</TableHead><TableHead value="status">Status</TableHead><TableHead value="trigger">Trigger</TableHead><TableHead value="jobs">Jobs</TableHead><TableHead value="created">Created</TableHead><TableHead value="action"><span class="sr-only">Action</span></TableHead></TableRow></TableHeader>
        <TableBody>
          {#each data.runs as run (run.runId)}
            <TableRow value={run.runId}>
              <TableCell value={`${run.runId}-id`}><code>{run.runId.slice(0, 10)}</code></TableCell>
              <TableCell value={`${run.runId}-repo`}><strong>{run.pipelineRef?.repo || '—'}</strong><span class="table-secondary">{run.pipelineRef?.ref || '—'}</span></TableCell>
              <TableCell value={`${run.runId}-status`}><StatusBadge status={run.status} /></TableCell>
              <TableCell value={`${run.runId}-trigger`}>{run.trigger?.type ?? '—'}</TableCell>
              <TableCell value={`${run.runId}-jobs`}>{run.jobs?.length ?? 0}</TableCell>
              <TableCell value={`${run.runId}-created`}>{formatValue(run.createdAt, 'datetime')}</TableCell>
              <TableCell value={`${run.runId}-action`}>
                <ButtonRoot variant="ghost" size="sm" aria-label={`Open run ${run.runId}`} onclick={() => void goto(`/modules/cifn/runs/${encodeURIComponent(run.runId)}`)}>
                  <ButtonLabel>Inspect</ButtonLabel><ButtonIcon><ConsoleIcon name="arrow-right" /></ButtonIcon>
                </ButtonRoot>
              </TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </TableTable>
    </TableRoot>
  {/if}

  {#if data.nextCursor}
    <div class="pagination-bar">
      <span>More pipeline runs are available.</span>
      <ButtonRoot variant="outline" onclick={() => {
        const url = new URL(window.location.href);
        url.searchParams.set('cursor', data.nextCursor!);
        void goto(`${url.pathname}${url.search}`);
      }}><ButtonLabel>Next page</ButtonLabel><ButtonIcon><ConsoleIcon name="arrow-right" /></ButtonIcon></ButtonRoot>
    </div>
  {/if}
{/if}
