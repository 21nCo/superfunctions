<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Badge } from "@uifn/vue";
import {
  capabilitySupport,
  defaultExampleRoute,
  getScenarioRoute,
  normalizeExampleRoute,
  scenarios,
  type ExampleRouteHash,
  type ExampleScenarioId,
} from "@uifn/examples-shared";
import CommandCenterScenario from "./scenarios/CommandCenterScenario.vue";
import SettingsConsoleScenario from "./scenarios/SettingsConsoleScenario.vue";
import TeamDirectoryScenario from "./scenarios/TeamDirectoryScenario.vue";
import UnsupportedVirtualizedResultsScenario from "./scenarios/UnsupportedVirtualizedResultsScenario.vue";

const route = ref<ExampleRouteHash>(defaultExampleRoute);

const vueCapabilityMatrix = capabilitySupport.filter((entry) => entry.adapter === "vue");

const activeScenario = computed(() => {
  const activeId = route.value.replace("#/", "") as ExampleScenarioId;
  return scenarios.find((scenario) => scenario.id === activeId) ?? scenarios[0];
});

function syncRoute(hash?: string | null) {
  const normalized = normalizeExampleRoute(hash);
  route.value = normalized;

  if (typeof window !== "undefined" && window.location.hash !== normalized) {
    window.location.hash = normalized;
  }
}

function handleHashChange() {
  syncRoute(window.location.hash);
}

onMounted(() => {
  if (typeof window === "undefined") {
    return;
  }

  syncRoute(window.location.hash);
  window.addEventListener("hashchange", handleHashChange);
});

onBeforeUnmount(() => {
  if (typeof window === "undefined") {
    return;
  }

  window.removeEventListener("hashchange", handleHashChange);
});
</script>

<template>
  <main class="app-shell">
    <section class="hero-panel">
      <div>
        <p class="eyebrow">uifn examples</p>
        <h1>Vue Playground</h1>
        <p class="hero-copy">
          Scenario-driven demos for the experimental Vue adapter, using the shared example registry
          and capability matrix without claiming unavailable primitives.
        </p>
      </div>
      <Badge class="adapter-badge">Vue Experimental</Badge>
    </section>

    <div class="workspace-grid">
      <aside class="panel navigation-panel" aria-label="Scenario navigation">
        <h2>Scenarios</h2>
        <nav>
          <ul class="scenario-list">
            <li v-for="scenario in scenarios" :key="scenario.id">
              <a
                :class="['scenario-link', { active: scenario.id === activeScenario.id }]"
                :href="getScenarioRoute(scenario.id)"
                :aria-current="scenario.id === activeScenario.id ? 'page' : undefined"
              >
                <span>{{ scenario.title }}</span>
                <small>{{ scenario.description }}</small>
              </a>
            </li>
          </ul>
        </nav>
      </aside>

      <section class="panel scenario-panel" aria-labelledby="active-scenario-heading">
        <div class="panel-heading">
          <div>
            <p class="section-label">Active route</p>
            <h2 id="active-scenario-heading">{{ activeScenario.title }}</h2>
          </div>
          <code>{{ route }}</code>
        </div>
        <p class="scenario-description">{{ activeScenario.description }}</p>

        <SettingsConsoleScenario v-if="activeScenario.id === 'settings-console'" :route="route" />
        <TeamDirectoryScenario v-else-if="activeScenario.id === 'team-directory'" :route="route" />
        <CommandCenterScenario v-else-if="activeScenario.id === 'command-center'" :route="route" />
        <UnsupportedVirtualizedResultsScenario v-else :route="route" />
      </section>

      <aside class="panel capability-panel">
        <h2>Capability Matrix</h2>
        <div class="matrix-wrapper">
          <table class="capability-table">
            <caption class="sr-only">Vue adapter capability support</caption>
            <thead>
              <tr>
                <th scope="col">Capability</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in vueCapabilityMatrix" :key="entry.capability">
                <th scope="row">{{ entry.capability }}</th>
                <td>
                  <span
                    :class="[
                      'status-chip',
                      entry.status === 'supported' ? 'supported' : 'unsupported',
                    ]"
                  >
                    {{ entry.status }}
                  </span>
                  <small v-if="entry.note">{{ entry.note }}</small>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </aside>
    </div>
  </main>
</template>
