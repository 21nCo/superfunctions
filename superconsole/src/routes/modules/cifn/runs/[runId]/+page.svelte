<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ButtonIcon, ButtonLabel, ButtonRoot } from '@uifn/components-svelte/button';
  import { CardContent, CardDescription, CardHeader, CardRoot, CardTitle } from '@uifn/components-svelte/card';
  import ActionButton from '$lib/components/ActionButton.svelte';
  import { scopedConsoleHref } from '$lib/components/admin-api';
  import ConsoleIcon from '$lib/components/ConsoleIcon.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import StatePanel from '$lib/components/StatePanel.svelte';
  import StatusBadge from '$lib/components/StatusBadge.svelte';
  import { normalizeCiRun } from '$lib/components/cifn';
  import { formatValue, moduleById, type AdminActionViewModel } from '$lib/components/view-models';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const run = $derived(normalizeCiRun(data.run, data.runId));
  const runResource = $derived(moduleById(data.shell.registry, 'cifn')?.resources?.find((resource) => resource.resourceId === 'runs' || resource.id === 'runs'));

  function boundRunAction(operationId: string): AdminActionViewModel | undefined {
    const action = runResource?.actions?.find((candidate) => candidate.id === operationId);
    if (!action?.targetIdInput || !run) return undefined;
    return {
      ...action,
      input: { ...(action.input ?? {}), [action.targetIdInput]: run.runId },
    };
  }

  const retryAction = $derived(boundRunAction('cifn.runs.retry-run'));
  const cancelAction = $derived(boundRunAction('cifn.runs.cancel-run'));
</script>

{#if !run}
  <PageHeader eyebrow="CiFn run" title="Run unavailable" backHref="/modules/cifn" />
  <StatePanel kind={data.loadError?.status === 404 ? 'not-found' : data.loadError?.status === 403 ? 'forbidden' : 'error'} error={data.loadError} actionHref="/modules/cifn" actionLabel="Back to runs" />
{:else}
  <PageHeader eyebrow={`${run.pipelineRef.repo} · ${run.trigger.type}`} title={`Run ${run.runId.slice(0, 10)}`} description={run.createdAt ? `Created ${formatValue(run.createdAt, 'datetime')}` : 'Creation time unavailable'} backHref="/modules/cifn">
    {#snippet actions()}
      {#if retryAction && ['success', 'failure', 'cancelled'].includes(run.status)}
        <ActionButton action={retryAction} />
      {/if}
      {#if cancelAction && ['queued', 'running'].includes(run.status)}
        <ActionButton action={cancelAction} />
      {/if}
      <ButtonRoot variant="outline" onclick={() => void goto(scopedConsoleHref(`/modules/cifn/runs/${encodeURIComponent(run.runId)}/artifacts`, page.url.searchParams))}>
        <ButtonIcon><ConsoleIcon name="download" /></ButtonIcon><ButtonLabel>Artifacts</ButtonLabel>
      </ButtonRoot>
    {/snippet}
  </PageHeader>

  <div class="run-detail-meta">
    <StatusBadge status={run.status} />
    <span>Ref <code>{run.pipelineRef.ref}</code></span>
    {#if run.pipelineRef.configPath}<span>Pipeline <code>{run.pipelineRef.configPath}</code></span>{/if}
    {#if run.updatedAt}<span>Updated {formatValue(run.updatedAt, 'datetime')}</span>{/if}
  </div>

  <section aria-labelledby="jobs-heading">
    <div class="section-heading"><div><p class="eyebrow">Execution graph</p><h2 id="jobs-heading">Jobs</h2></div><StatusBadge label={`${run.jobs.length} jobs`} tone="neutral" /></div>
    {#if run.jobs.length === 0}
      <StatePanel kind="empty" title="No jobs" message="The run has not materialized any jobs yet." />
    {:else}
      <div class="job-grid">
        {#each run.jobs as job (job.id)}
          <CardRoot class="job-card">
            <CardHeader>
              <div class="job-card__number" aria-hidden="true">{run.jobs.indexOf(job) + 1}</div>
              <CardTitle>{job.jobKey}</CardTitle>
              <CardDescription>{job.steps.length} steps{#if job.startedAt} · started {formatValue(job.startedAt, 'datetime')}{/if}</CardDescription>
              <StatusBadge status={job.status} />
            </CardHeader>
            <CardContent>
              <ol class="step-list">
                {#each job.steps as step (step.id)}
                  <li><StatusBadge status={step.status} /><code>{step.stepKey}</code>{#if step.completedAt}<time>{formatValue(step.completedAt, 'datetime')}</time>{/if}</li>
                {/each}
              </ol>
              <ButtonRoot variant="outline" size="sm" onclick={() => void goto(scopedConsoleHref(`/modules/cifn/runs/${encodeURIComponent(run.runId)}/jobs/${encodeURIComponent(job.jobKey)}/logs`, page.url.searchParams))}>
                <ButtonIcon><ConsoleIcon name="terminal" /></ButtonIcon><ButtonLabel>View logs</ButtonLabel>
              </ButtonRoot>
            </CardContent>
          </CardRoot>
        {/each}
      </div>
    {/if}
  </section>
{/if}
