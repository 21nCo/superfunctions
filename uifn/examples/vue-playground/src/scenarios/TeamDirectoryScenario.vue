<script setup lang="ts">
import {
  Avatar,
  AvatarFallback,
  Badge,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@uifn/vue";
import { teamMembers, type ExampleRouteHash } from "@uifn/examples-shared";

defineProps<{ route: ExampleRouteHash }>();

const statusEmoji = {
  active: "●",
  away: "◐",
  offline: "○",
} as const;
</script>

<template>
  <div class="scenario-stack" :data-route="route">
    <p class="scenario-note">
      Directory cards keep profile details in the main flow while menus, popovers, and hover cards
      reveal secondary context.
    </p>

    <div class="member-grid">
      <article v-for="member in teamMembers" :key="member.id" class="member-card">
        <div class="member-topline">
          <Avatar>
            <AvatarFallback>{{ member.initials }}</AvatarFallback>
          </Avatar>
          <Badge>{{ member.status }}</Badge>
        </div>

        <div class="scenario-stack">
          <HoverCard :open-delay="0" :close-delay="120">
            <HoverCardTrigger class="member-name-link" :href="`#/${route.replace('#/', '')}`">
              {{ member.name }}
            </HoverCardTrigger>
            <HoverCardContent>
              <div class="hover-card-panel">
                <strong>{{ member.role }}</strong>
                <p class="scenario-note">{{ member.location }} coverage</p>
              </div>
            </HoverCardContent>
          </HoverCard>

          <p class="member-role">{{ member.role }}</p>
          <p class="command-meta">
            <span :data-status="member.status">{{ statusEmoji[member.status] }}</span>
            {{ member.location }}
          </p>
        </div>

        <div class="member-actions">
          <div class="menu-shell">
            <DropdownMenu>
              <DropdownMenuTrigger>Actions for {{ member.name }}</DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuLabel>Team actions</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem>Open profile</DropdownMenuItem>
                <DropdownMenuItem>Request review</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div class="popover-shell">
            <Popover>
              <PopoverTrigger>View location</PopoverTrigger>
              <PopoverContent>
                <div class="popover-card">
                  <strong>{{ member.location }}</strong>
                  <p class="scenario-note">Shared fixture profile for {{ member.name }}.</p>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </article>
    </div>
  </div>
</template>
