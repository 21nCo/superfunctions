<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Drawfn, type DrawfnOptions, type Scene, type ToolName } from '@21n/drawfn';
  import Canvas from './Canvas.svelte';

  export let width = 800;
  export let height = 600;
  export let scene: Scene | undefined = undefined;
  export let overlayRoot: HTMLElement | undefined = undefined;
  export let getImageBitmap: DrawfnOptions['getImageBitmap'] = undefined;
  export let onReady: ((drawfn: Drawfn) => void) | undefined = undefined;
  export let onSceneChange: ((scene: Scene) => void) | undefined = undefined;

  let canvas: HTMLCanvasElement;
  let drawfn: Drawfn | null = null;
  let className = '';
  export { className as class };

  onMount(() => {
    if (!canvas) return;

    drawfn = new Drawfn({
      canvas,
      overlayRoot,
      getImageBitmap,
    });

    if (scene) {
      drawfn.load(scene);
    }

    if (onSceneChange) {
      drawfn.on('elementAdded', () => onSceneChange?.(drawfn!.getScene()));
      drawfn.on('elementUpdated', () => onSceneChange?.(drawfn!.getScene()));
      drawfn.on('elementRemoved', () => onSceneChange?.(drawfn!.getScene()));
    }

    onReady?.(drawfn);
  });

  onDestroy(() => {
    drawfn?.destroy();
  });

  $: if (drawfn && scene) {
    drawfn.load(scene);
  }

  // Expose drawfn instance
  export function getDrawfn(): Drawfn | null {
    return drawfn;
  }

  export function setTool(tool: ToolName, opts?: any): void {
    drawfn?.setTool(tool, opts);
  }

  export function undo(): void {
    drawfn?.undo();
  }

  export function redo(): void {
    drawfn?.redo();
  }

  export function clear(): void {
    drawfn?.clear();
  }

  export async function exportPNG(opts?: Parameters<Drawfn['exportPNG']>[0]): Promise<Blob | undefined> {
    return await drawfn?.exportPNG(opts);
  }

  export async function exportSVG(opts?: Parameters<Drawfn['exportSVG']>[0]): Promise<string | undefined> {
    return await drawfn?.exportSVG(opts);
  }
</script>

<Canvas bind:canvas {width} {height} class={className} {...$$restProps} />
