<script setup lang="ts">
import { computed, ref } from "vue";
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxTrigger,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  ScrollArea,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectTrigger,
  SelectValue,
  SelectViewport,
} from "@uifn/vue";
import { commandItems, type ExampleRouteHash } from "@uifn/examples-shared";

defineProps<{ route: ExampleRouteHash }>();

const selectedCommand = ref("");
const commandQuery = ref("");
const selectedGroup = ref("all");

const groups = ["all", ...new Set(commandItems.map((item) => item.group))];

const filteredCommands = computed(() => {
  const normalizedQuery = commandQuery.value.trim().toLowerCase();

  return commandItems.filter((item) => {
    const matchesGroup = selectedGroup.value === "all" || item.group === selectedGroup.value;
    const matchesQuery =
      normalizedQuery.length === 0 || item.title.toLowerCase().includes(normalizedQuery);
    return matchesGroup && matchesQuery;
  });
});

const currentCommand = computed(
  () =>
    filteredCommands.value.find((item) => item.id === selectedCommand.value) ??
    filteredCommands.value[0],
);
</script>

<template>
  <div class="scenario-stack" :data-route="route">
    <p class="scenario-note">
      This route combines filtering, selection, scroll management, and context actions without
      relying on remote data.
    </p>

    <div class="command-grid">
      <section>
        <h3>Command Search</h3>
        <Combobox v-model:value="selectedCommand" v-model:input-value="commandQuery">
          <div class="combobox-shell">
            <ComboboxInput aria-label="Search commands" placeholder="Search commands" />
            <ComboboxTrigger>Browse</ComboboxTrigger>
          </div>
          <ComboboxContent>
            <ComboboxItem v-for="item in filteredCommands" :key="item.id" :value="item.id">
              <span>{{ item.title }}</span>
              <ComboboxItemIndicator>✓</ComboboxItemIndicator>
            </ComboboxItem>
          </ComboboxContent>
        </Combobox>

        <p class="command-meta">
          Active command:
          <strong>{{ currentCommand?.title ?? "No matching command" }}</strong>
        </p>
      </section>

      <section>
        <h3>Group Filter</h3>
        <div class="scenario-select-shell">
          <Select v-model:value="selectedGroup">
            <SelectTrigger aria-label="Filter command group">
              <SelectValue placeholder="Choose a command group" />
            </SelectTrigger>
            <SelectContent>
              <SelectViewport>
                <SelectItem v-for="group in groups" :key="group" :value="group">
                  <span>{{ group }}</span>
                  <SelectItemIndicator>✓</SelectItemIndicator>
                </SelectItem>
              </SelectViewport>
            </SelectContent>
          </Select>
        </div>

        <p class="command-meta">
          Showing {{ filteredCommands.length }} command{{ filteredCommands.length === 1 ? "" : "s" }}.
        </p>
      </section>

      <section>
        <h3>Visible Commands</h3>
        <ScrollArea style="height: 240px; border-radius: 18px">
          <ScrollAreaViewport>
            <ul class="command-list">
              <li v-for="item in filteredCommands" :key="item.id" class="command-row">
                <strong>{{ item.title }}</strong>
                <span class="command-meta">{{ item.shortcut }}</span>
              </li>
            </ul>
          </ScrollAreaViewport>
          <ScrollAreaScrollbar orientation="vertical">
            <ScrollAreaThumb />
          </ScrollAreaScrollbar>
        </ScrollArea>
      </section>

      <section>
        <h3>Bulk Actions</h3>
        <ContextMenu>
          <ContextMenuTrigger>
            <div class="context-target" tabindex="0">
              Right-click or keyboard-focus this surface to reveal maintenance actions for the
              visible command set.
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>Pin visible commands</ContextMenuItem>
            <ContextMenuItem>Copy shortcuts summary</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </section>
    </div>
  </div>
</template>
