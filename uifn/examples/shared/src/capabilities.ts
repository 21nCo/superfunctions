import type { ExampleAdapterId, ExampleCapabilityId } from "./scenarios.js";

export interface ExampleCapabilitySupport {
  adapter: ExampleAdapterId;
  capability: ExampleCapabilityId;
  status: "supported" | "unsupported";
  note?: string;
}

export const vueVirtualizedListUnsupportedNote =
  "VirtualizedList is not exported by @uifn/vue";

export const capabilitySupport: ExampleCapabilitySupport[] = [
  { adapter: "react", capability: "dialog", status: "supported" },
  { adapter: "react", capability: "tabs", status: "supported" },
  { adapter: "react", capability: "switch", status: "supported" },
  { adapter: "react", capability: "checkbox", status: "supported" },
  { adapter: "react", capability: "toast", status: "supported" },
  { adapter: "react", capability: "avatar", status: "supported" },
  { adapter: "react", capability: "badge", status: "supported" },
  { adapter: "react", capability: "dropdown-menu", status: "supported" },
  { adapter: "react", capability: "popover", status: "supported" },
  { adapter: "react", capability: "hover-card", status: "supported" },
  { adapter: "react", capability: "combobox", status: "supported" },
  { adapter: "react", capability: "select", status: "supported" },
  { adapter: "react", capability: "scroll-area", status: "supported" },
  { adapter: "react", capability: "context-menu", status: "supported" },
  { adapter: "react", capability: "virtualized-list", status: "supported" },

  { adapter: "svelte", capability: "dialog", status: "supported" },
  { adapter: "svelte", capability: "tabs", status: "supported" },
  { adapter: "svelte", capability: "switch", status: "supported" },
  { adapter: "svelte", capability: "checkbox", status: "supported" },
  { adapter: "svelte", capability: "toast", status: "supported" },
  { adapter: "svelte", capability: "avatar", status: "supported" },
  { adapter: "svelte", capability: "badge", status: "supported" },
  { adapter: "svelte", capability: "dropdown-menu", status: "supported" },
  { adapter: "svelte", capability: "popover", status: "supported" },
  { adapter: "svelte", capability: "hover-card", status: "supported" },
  { adapter: "svelte", capability: "combobox", status: "supported" },
  { adapter: "svelte", capability: "select", status: "supported" },
  { adapter: "svelte", capability: "scroll-area", status: "supported" },
  { adapter: "svelte", capability: "context-menu", status: "supported" },
  { adapter: "svelte", capability: "virtualized-list", status: "supported" },

  { adapter: "vue", capability: "dialog", status: "supported" },
  { adapter: "vue", capability: "tabs", status: "supported" },
  { adapter: "vue", capability: "switch", status: "supported" },
  { adapter: "vue", capability: "checkbox", status: "supported" },
  { adapter: "vue", capability: "toast", status: "supported" },
  { adapter: "vue", capability: "avatar", status: "supported" },
  { adapter: "vue", capability: "badge", status: "supported" },
  { adapter: "vue", capability: "dropdown-menu", status: "supported" },
  { adapter: "vue", capability: "popover", status: "supported" },
  { adapter: "vue", capability: "hover-card", status: "supported" },
  { adapter: "vue", capability: "combobox", status: "supported" },
  { adapter: "vue", capability: "select", status: "supported" },
  { adapter: "vue", capability: "scroll-area", status: "supported" },
  { adapter: "vue", capability: "context-menu", status: "supported" },
  {
    adapter: "vue",
    capability: "virtualized-list",
    status: "unsupported",
    note: vueVirtualizedListUnsupportedNote,
  },
];
