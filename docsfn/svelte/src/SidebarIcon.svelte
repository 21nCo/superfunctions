<script lang="ts">
  import type { ComponentType } from "svelte";
  import BookOpen from "@lucide/svelte/icons/book-open";
  import Boxes from "@lucide/svelte/icons/boxes";
  import Braces from "@lucide/svelte/icons/braces";
  import Code2 from "@lucide/svelte/icons/code-2";
  import FileText from "@lucide/svelte/icons/file-text";
  import Rocket from "@lucide/svelte/icons/rocket";
  import Settings2 from "@lucide/svelte/icons/settings-2";
  import Terminal from "@lucide/svelte/icons/terminal";
  import Wrench from "@lucide/svelte/icons/wrench";

  export let name: string;
  export let size = 15;

  const icons: Record<string, ComponentType> = {
    book: BookOpen,
    "book-open": BookOpen,
    boxes: Boxes,
    blocks: Boxes,
    braces: Braces,
    code: Code2,
    "code-2": Code2,
    file: FileText,
    "file-text": FileText,
    rocket: Rocket,
    settings: Settings2,
    "settings-2": Settings2,
    terminal: Terminal,
    wrench: Wrench,
  };

  $: normalizedName = name.trim().toLowerCase().replace(/[\s_]+/g, "-");
  $: Icon = icons[normalizedName] ?? FileText;
</script>

<svelte:component this={Icon} {size} strokeWidth={1.8} aria-hidden="true" />
