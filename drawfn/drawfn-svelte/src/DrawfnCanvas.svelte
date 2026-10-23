<script lang="ts">
  import { onMount } from "svelte";
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
  export let onReady: ((drawfn: Drawfn) => void) | undefined = undefined;
  export let onSceneChange:
    | ((scene: Scene, meta?: SceneChangedEvent) => void)
    | undefined = undefined;

  let canvas: HTMLCanvasElement | null = null;
  let drawfn: Drawfn | null = null;
  let lastLoadedSceneKey: string | null = null;
  let unsubscribeSceneChanged: (() => void) | undefined = undefined;
  let className = "";
  export { className as class };

  function scenesAreEqual(left?: Scene, right?: Scene): boolean {
    if (!left || !right) {
      return left === right;
    }

    return JSON.stringify(left) === JSON.stringify(right);
  }

  function serializeScene(value?: Scene): string | null {
    return value ? JSON.stringify(value) : null;
  }

  onMount(() => {
    if (!canvas) return;

    const instance = new Drawfn({
      canvas,
      overlayRoot,
      getImageBitmap,
    });
    drawfn = instance;

    unsubscribeSceneChanged = instance.on("sceneChanged", (meta) => {
      onSceneChange?.(meta.scene, meta);
    }) ?? undefined;

    const sceneKey = serializeScene(scene);
    if (scene && !scenesAreEqual(instance.getScene(), scene)) {
      lastLoadedSceneKey = sceneKey;
      instance.load(scene);
    }

    onReady?.(instance);

    return () => {
      unsubscribeSceneChanged?.();
      instance.destroy();
      unsubscribeSceneChanged = undefined;
      lastLoadedSceneKey = null;
      drawfn = null;
    };
  });

  $: if (drawfn && scene) {
    const sceneKey = serializeScene(scene);
    if (
      sceneKey !== lastLoadedSceneKey &&
      !scenesAreEqual(drawfn.getScene(), scene)
    ) {
      lastLoadedSceneKey = sceneKey;
      drawfn.load(scene);
    } else {
      lastLoadedSceneKey = sceneKey;
    }
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

<canvas
  bind:this={canvas}
  {width}
  {height}
  class={className}
  style={`display: block; touch-action: none; ${$$restProps.style ?? ""}`}
  {...$$restProps}
/>
