<script lang="ts">
  import { onDestroy } from "svelte";
  import { drawfn as drawfnAction, type DrawfnActionOptions } from "./drawfn-action";
  import {
    Drawfn,
    type DrawfnOptions,
    type Scene,
    type SceneChangedEvent,
    type ToolName,
  } from "drawfn";

  export let width = 800;
  export let height = 600;
  export let scene: Scene | undefined = undefined;
  export let overlayRoot: HTMLElement | undefined = undefined;
  export let getImageBitmap: DrawfnOptions['getImageBitmap'] = undefined;
  export let onNodeClick: DrawfnOptions['onNodeClick'] = undefined;
  export let getNodePreview: DrawfnOptions['getNodePreview'] = undefined;
  export let onReady: ((drawfn: Drawfn) => void) | undefined = undefined;
  export let onSceneChange:
    | ((scene: Scene, meta?: SceneChangedEvent) => void)
    | undefined = undefined;

  let canvas: HTMLCanvasElement | null = null;
  let drawfn: Drawfn | null = null;
  let className = "";
  export { className as class };
  const handleReady = (instance: Drawfn) => {
    drawfn = instance;
    onReady?.(instance);
  };
  let actionOptions: DrawfnActionOptions;
  $: actionOptions = { scene, overlayRoot, getImageBitmap, onNodeClick, getNodePreview, onReady: handleReady, onSceneChange };
  onDestroy(() => { drawfn = null; });

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

<canvas
  bind:this={canvas}
  use:drawfnAction={actionOptions}
  {width}
  {height}
  class={className}
  style={`display: block; touch-action: none; ${$$restProps.style ?? ""}`}
  {...$$restProps}
></canvas>
