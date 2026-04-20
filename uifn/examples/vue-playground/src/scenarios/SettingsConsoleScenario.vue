<script setup lang="ts">
import { ref } from "vue";
import {
  Checkbox,
  CheckboxIndicator,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  Switch,
  SwitchThumb,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@uifn/vue";
import { settingsSections, settingsToggles, type ExampleRouteHash } from "@uifn/examples-shared";

defineProps<{ route: ExampleRouteHash }>();

const dialogOpen = ref(false);
const toastOpen = ref(false);
const activeTab = ref(settingsSections[0]?.id ?? "general");
const switchStates = ref<Record<string, boolean>>(
  Object.fromEntries(settingsToggles.map((toggle) => [toggle.id, toggle.defaultEnabled])),
);
const checkboxStates = ref<Record<string, boolean>>({
  general: true,
  notifications: false,
  security: true,
});

function applySettings() {
  dialogOpen.value = false;
  toastOpen.value = true;
}
</script>

<template>
  <ToastProvider>
    <div class="scenario-stack" :data-route="route">
      <div class="scenario-toolbar">
        <div class="dialog-trigger-shell">
          <Dialog v-model:open="dialogOpen">
            <DialogTrigger>Open settings console</DialogTrigger>
            <DialogPortal>
              <DialogOverlay />
              <DialogContent>
                <div class="dialog-surface">
                  <div class="dialog-header">
                    <div>
                      <DialogTitle>Workspace settings</DialogTitle>
                      <DialogDescription>
                        Review shared defaults, notification rules, and approval prompts.
                      </DialogDescription>
                    </div>
                    <span class="unsupported-pill">Experimental adapter</span>
                  </div>

                  <Tabs v-model:value="activeTab" :default-value="activeTab">
                    <TabsList class="tabs-list" aria-label="Settings sections">
                      <TabsTrigger
                        v-for="section in settingsSections"
                        :key="section.id"
                        :value="section.id"
                      >
                        {{ section.title }}
                      </TabsTrigger>
                    </TabsList>

                    <TabsContent
                      v-for="section in settingsSections"
                      :key="section.id"
                      :value="section.id"
                    >
                      <div class="tab-panel">
                        <p class="scenario-note">{{ section.description }}</p>

                        <div
                          v-for="toggle in settingsToggles.filter((item) => item.sectionId === section.id)"
                          :key="toggle.id"
                          class="control-row"
                        >
                          <span>
                            <strong>{{ toggle.label }}</strong>
                            <small>{{ toggle.description }}</small>
                          </span>

                          <div class="switch-shell">
                            <Switch v-model:checked="switchStates[toggle.id]">
                              <span class="sr-only">{{ toggle.label }}</span>
                              <SwitchThumb />
                            </Switch>
                          </div>
                        </div>

                        <div class="control-row">
                          <span>
                            <strong>Require section confirmation</strong>
                            <small>Explicitly acknowledge changes before they are applied.</small>
                          </span>

                          <div class="checkbox-shell">
                            <Checkbox v-model:checked="checkboxStates[section.id]">
                              <span class="sr-only">
                                Require {{ section.title.toLowerCase() }} confirmation
                              </span>
                              <CheckboxIndicator>✓</CheckboxIndicator>
                            </Checkbox>
                          </div>
                        </div>
                      </div>
                    </TabsContent>
                  </Tabs>

                  <div class="dialog-actions">
                    <button type="button" class="primary-button" @click="applySettings">
                      Apply settings
                    </button>
                    <div class="close-shell">
                      <DialogClose>Close panel</DialogClose>
                    </div>
                  </div>
                </div>
              </DialogContent>
            </DialogPortal>
          </Dialog>
        </div>

        <p class="scenario-note">
          The settings console keeps the route-local shell stable while using Vue primitives for
          dialog, tabs, toggles, checkboxes, and toast feedback.
        </p>
      </div>

      <Toast v-model:open="toastOpen" :duration="3500">
        <div class="toast-surface">
          <ToastTitle>Preferences applied</ToastTitle>
          <ToastDescription>Shared example settings were saved for this local session.</ToastDescription>
          <ToastClose>Dismiss notice</ToastClose>
        </div>
      </Toast>
      <ToastViewport />
    </div>
  </ToastProvider>
</template>
