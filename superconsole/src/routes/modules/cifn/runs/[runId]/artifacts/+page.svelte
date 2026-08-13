<script lang="ts">
  import { CardContent, CardDescription, CardFooter, CardHeader, CardRoot, CardTitle } from '@uifn/components-svelte/card';
  import ActionButton from '$lib/components/ActionButton.svelte';
  import ConsoleIcon from '$lib/components/ConsoleIcon.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import StatePanel from '$lib/components/StatePanel.svelte';
  import { moduleById, type AdminActionViewModel, type CiArtifactViewModel } from '$lib/components/view-models';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const artifactResource = $derived(moduleById(data.shell.registry, 'cifn')?.resources?.find((resource) => resource.resourceId === 'artifacts' || resource.id === 'artifacts'));
  const projectedDownloadAction = $derived(artifactResource?.actions?.find((action) => action.id === 'cifn.artifacts.download-artifact' || action.id.endsWith('.download-artifact')));

  function downloadAction(artifact: CiArtifactViewModel): AdminActionViewModel | undefined {
    const identity = artifact.id ?? artifact.fileId;
    if (!projectedDownloadAction?.targetIdInput || !identity) return undefined;
    return {
      ...projectedDownloadAction,
      label: 'Request download',
      input: {
        ...(projectedDownloadAction.input ?? {}),
        [projectedDownloadAction.targetIdInput]: identity,
        runId: data.runId,
      },
    };
  }

  function formatBytes(value?: number) {
    if (value === undefined) return undefined;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
</script>

<PageHeader eyebrow={`CiFn run ${data.runId.slice(0, 10)}`} title="Artifacts" description="Build outputs retained by FileFn for this pipeline run." backHref={`/modules/cifn/runs/${encodeURIComponent(data.runId)}`} />

{#if data.loadError?.status === 403}
  <StatePanel kind="forbidden" error={data.loadError} />
{:else if data.loadError}
  <StatePanel kind="error" error={data.loadError} />
{:else if data.artifacts.length === 0}
  <StatePanel kind="empty" title="No artifacts" message="This run did not publish any retained build outputs." />
{:else}
  <div class="artifact-grid">
    {#each data.artifacts as artifact (artifact.name)}
      <CardRoot class="artifact-card">
        <CardHeader><div class="artifact-card__icon"><ConsoleIcon name="download" size={22} /></div><CardTitle>{artifact.name}</CardTitle><CardDescription>{artifact.contentType ?? 'Build artifact'}{#if formatBytes(artifact.size)} · {formatBytes(artifact.size)}{/if}</CardDescription></CardHeader>
        <CardContent>{#if artifact.fileId}<span>FileFn ID</span><code>{artifact.fileId}</code>{/if}</CardContent>
        {@const action = downloadAction(artifact)}
        {#if action}<CardFooter><ActionButton {action} compact openDownloadReceipt /></CardFooter>{/if}
      </CardRoot>
    {/each}
  </div>
{/if}
