<script setup lang="ts">
import { Badge } from "@uifn/vue";
import {
  resultRows,
  vueVirtualizedListUnsupportedNote,
  type ExampleRouteHash,
} from "@uifn/examples-shared";

defineProps<{ route: ExampleRouteHash }>();
</script>

<template>
  <section
    class="unsupported-card"
    :data-route="route"
    data-mode="unsupported"
    role="status"
    aria-live="polite"
    aria-label="Virtualized results unavailable in Vue"
    tabindex="0"
  >
    <header>
      <div>
        <p class="section-label">Unsupported Scenario</p>
        <h3>Virtualized Results</h3>
      </div>
      <Badge>Unavailable</Badge>
    </header>

    <p>
      {{ vueVirtualizedListUnsupportedNote }} This route stays visible so the shared navigation and
      documentation contract remain truthful.
    </p>

    <ul class="unsupported-list">
      <li>The shared fixture still includes {{ resultRows.length }} logical rows.</li>
      <li>React and Svelte demonstrate virtualized rendering for this scenario.</li>
      <li>Vue keeps the route stable and announces the limitation instead of crashing.</li>
    </ul>

    <a class="ghost-button" href="#/settings-console">Return to settings console</a>
  </section>
</template>
