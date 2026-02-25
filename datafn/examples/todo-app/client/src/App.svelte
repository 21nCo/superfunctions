<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { toSvelteStore } from "@datafn/svelte";
  import {
    client,
    switchMode,
    auditLog,
    type AppMode,
    type AuditEntry,
  } from "./lib/datafn";

  // ── Mode toggle (sync vs local-only) ──────────────────────────────────
  let currentMode: AppMode = "sync";
  let isSwitching = false;

  async function handleModeSwitch() {
    if (isSwitching) return;
    const next: AppMode = currentMode === "sync" ? "local-only" : "sync";
    isSwitching = true;
    try {
      currentMode = next;
      await switchMode(next);
    } catch (e) {
      console.error("[DEBUG] Mode switch failed:", e);
    } finally {
      isSwitching = false;
    }
  }

  // ── State ──────────────────────────────────────────────────────────────
  let newTodoText = "";
  let newTodoPriority = 3;
  let newCategoryName = "";
  let newCategoryColor = "#646cff";
  let selectedCategoryId: string | null = null;
  let filterView: "all" | "active" | "completed" = "all";
  let activeTab = "todos";

  // ── Event log ──────────────────────────────────────────────────────────
  let eventEntries: Array<{ ts: number; type: string; detail: string }> = [];
  let unsubEvents: (() => void) | null = null;
  const MAX_EVENTS = 40;

  // Re-subscribe to the event bus whenever the underlying client changes.
  // client.subscribeClient passes the stable proxy on each switch.
  const unsubClientForEvents = client.subscribeClient((c) => {
    unsubEvents?.();
    unsubEvents = c.subscribe((event) => {
      console.log("[DEBUG] Event:", event.type, (event as any).resource, (event as any).action, (event as any).ids);
      eventEntries = [
        {
          ts: event.timestampMs,
          type: event.type,
          detail: `${(event as any).action ?? ""} ${(event as any).resource ?? ""} ${((event as any).ids ?? []).join(",")}`.trim(),
        },
        ...eventEntries,
      ].slice(0, MAX_EVENTS);
    });
  });

  // ── Signals — lifecycle-aware LiveSignals (survive switchContext automatically) ──
  const allTodosStore = toSvelteStore(
    client.table("todos").signal({ sort: ["-createdAt"], select: ["*", "tags.*"] })
  );

  const activeTodosStore = toSvelteStore(
    client.table("todos").signal({ filters: { completed: false }, sort: ["createdAt:desc"], select: ["*", "tags.*"] })
  );

  const completedTodosStore = toSvelteStore(
    client.table("todos").signal({ filters: { completed: true }, sort: ["createdAt:desc"], select: ["*", "tags.*"] })
  );

  const categoriesStore = toSvelteStore(
    client.table("categories").signal({ sort: ["name"] })
  );

  // KV signals — reactive key-value preferences
  const themeSignalStore = toSvelteStore(
    client.kv.signal<string>("pref:theme", { defaultValue: "dark" })
  );

  const sortSignalStore = toSvelteStore(
    client.kv.signal<string>("pref:sort", { defaultValue: "createdAt:desc" })
  );

  // ── Lifecycle ──────────────────────────────────────────────────────────
  onMount(async () => {
    // Debug: test a direct query to see what comes back
    try {
      const directResult = await client.table("todos").query({ sort: ["createdAt:desc"] });
      console.log("[DEBUG] Direct query result:", JSON.stringify(directResult, null, 2));
    } catch (err) {
      console.error("[DEBUG] Direct query failed:", err);
    }

    if (currentMode === "sync") {
      try {
        await client.sync.start();
        console.log("[DEBUG] Sync started OK");
        try {
          const postSyncResult = await client.table("todos").query({ sort: ["createdAt:desc"] });
          console.log("[DEBUG] Post-sync query result:", JSON.stringify(postSyncResult, null, 2));
        } catch (err2) {
          console.error("[DEBUG] Post-sync query failed:", err2);
        }
      } catch (e) {
        console.error("[DEBUG] Sync start failed:", e);
      }
    }
  });

  onDestroy(() => {
    unsubEvents?.();
    unsubClientForEvents();
  });

  // ── Computed (reactive) ────────────────────────────────────────────────
  $: visibleTodos =
    filterView === "active"
      ? $activeTodosStore
      : filterView === "completed"
        ? $completedTodosStore
        : $allTodosStore;

  $: console.log("[DEBUG] $allTodosStore:", JSON.stringify($allTodosStore));
  $: console.log("[DEBUG] typeof $allTodosStore:", typeof $allTodosStore, "keys:", $allTodosStore && typeof $allTodosStore === "object" ? Object.keys($allTodosStore) : "N/A");

  $: todoData = visibleTodos?.data ?? [];
  $: allCount = ($allTodosStore?.data ?? []).length;
  $: activeCount = ($activeTodosStore?.data ?? []).length;
  $: completedCount = ($completedTodosStore?.data ?? []).length;
  $: categories = $categoriesStore?.data ?? [];
  $: currentTheme = $themeSignalStore?.data ?? "dark";
  $: currentSort = $sortSignalStore?.data ?? "createdAt:desc";

  $: console.log("[DEBUG] todoData:", JSON.stringify(todoData), "length:", todoData?.length, "isArray:", Array.isArray(todoData));

  // ── Mutations ──────────────────────────────────────────────────────────

  async function addTodo() {
    const text = newTodoText.trim();
    if (!text) return;

    console.log("[DEBUG] Adding todo:", text);
    try {
      const result = await client.table("todos").mutate({
        operation: "insert",
        record: {
          text,
          completed: false,
          priority: newTodoPriority,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      console.log("[DEBUG] addTodo result:", JSON.stringify(result, null, 2));
    } catch (err) {
      console.error("[DEBUG] addTodo failed:", err);
    }

    newTodoText = "";
    newTodoPriority = 3;
  }

  async function toggleTodo(todo: any) {
    await client.table("todos").mutate({
      operation: "merge",
      id: todo.id,
      record: {
        completed: !todo.completed,
        updatedAt: new Date(),
      },
    });
  }

  async function deleteTodo(todo: any) {
    await client.table("todos").mutate({
      operation: "delete",
      id: todo.id,
    });
  }

  /** Transaction: mark all visible todos as completed */
  async function markAllComplete() {
    const active = ($activeTodosStore?.data ?? []) as any[];
    if (!active.length) return;

    await client.transact({
      steps: active.map((t: any) => ({
        mutation: {
          resource: "todos",
          version: 1,
          operation: "merge",
          id: t.id,
          record: { completed: true, updatedAt: new Date() },
        },
      })),
    });
  }

  /** Transaction: delete all completed todos */
  async function clearCompleted() {
    const done = ($completedTodosStore?.data ?? []) as any[];
    if (!done.length) return;

    await client.transact({
      steps: done.map((t: any) => ({
        mutation: {
          resource: "todos",
          version: 1,
          operation: "delete",
          id: t.id,
        },
      })),
    });
  }

  // ── Category mutations ─────────────────────────────────────────────────

  async function addCategory() {
    const name = newCategoryName.trim();
    if (!name) return;

    await client.table("categories").mutate({
      operation: "insert",
      record: {
        name,
        color: newCategoryColor,
        createdAt: new Date(),
      },
    });

    newCategoryName = "";
    newCategoryColor = "#646cff";
  }

  async function deleteCategory(cat: any) {
    await client.table("categories").mutate({
      operation: "delete",
      id: cat.id,
    });
  }

  // ── Relation mutations (tag / untag) ───────────────────────────────────

  async function tagTodo(todoId: string, categoryId: string) {
    await client.mutate({
      resource: "todos",
      version: 1,
      operation: "relate",
      id: todoId,
      relations: {
        tags: { $ref: categoryId },
      },
    });
  }

  async function untagTodo(todoId: string, categoryId: string) {
    await client.mutate({
      resource: "todos",
      version: 1,
      operation: "unrelate",
      id: todoId,
      relations: {
        tags: { $ref: categoryId },
      },
    });
  }

  // ── KV mutations ───────────────────────────────────────────────────────

  async function setTheme(theme: string) {
    await client.kv.set("pref:theme", theme);
  }

  async function setSortPref(sort: string) {
    await client.kv.set("pref:sort", sort);
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  function priorityLabel(p: number | undefined): string {
    const labels: Record<number, string> = {
      1: "Lowest",
      2: "Low",
      3: "Medium",
      4: "High",
      5: "Critical",
    };
    return labels[p ?? 3] ?? "Medium";
  }

  function priorityColor(p: number | undefined): string {
    const colors: Record<number, string> = {
      1: "#888",
      2: "#6b9",
      3: "#6bf",
      4: "#fb6",
      5: "#f55",
    };
    return colors[p ?? 3] ?? "#6bf";
  }

  function fmtTime(ts: number): string {
    return new Date(ts).toLocaleTimeString();
  }
</script>

<main class:light={currentTheme === "light"}>
  <!-- ─── DEBUG PANEL ─────────────────────────────────────────────── -->
  <div style="background: #1a0a0a; border: 2px solid red; padding: 12px; margin: 8px; font-family: monospace; font-size: 11px; color: #ff6666; max-height: 200px; overflow: auto;">
    <strong>DEBUG PANEL</strong><br/>
    <div>$allTodosStore: {JSON.stringify($allTodosStore)?.slice(0, 300)}</div>
    <div>typeof: {typeof $allTodosStore}</div>
    <div>todoData length: {todoData?.length ?? "N/A"} | isArray: {Array.isArray(todoData)}</div>
    <div>allCount: {allCount} | activeCount: {activeCount} | completedCount: {completedCount}</div>
    <div>visibleTodos: {JSON.stringify(visibleTodos)?.slice(0, 200)}</div>
    <div>filterView: {filterView} | currentMode: {currentMode}</div>
  </div>

  <!-- ─── Header ────────────────────────────────────────────────────── -->
  <header>
    <h1>DataFn Todo App</h1>
    <p class="subtitle">
      Showcasing offline-first sync, signals, KV, relations, transactions,
      plugins &amp; more
    </p>

    <div class="header-controls">
      <button
        class="mode-btn"
        class:active={currentMode === "sync"}
        on:click={handleModeSwitch}
      >
        {currentMode === "sync" ? "● Sync Mode" : "○ Local-Only Mode"}
      </button>

      <button
        class="theme-btn"
        on:click={() => setTheme(currentTheme === "dark" ? "light" : "dark")}
      >
        {currentTheme === "dark" ? "☀ Light" : "☾ Dark"}
      </button>
    </div>
  </header>

  <!-- ─── Tab bar ───────────────────────────────────────────────────── -->
  <nav class="tabs">
    {#each ["todos", "categories", "kv", "events"] as tab}
      <button
        class="tab"
        class:active={activeTab === tab}
        on:click={() => (activeTab = tab)}
      >
        {tab === "todos"
          ? `Todos (${allCount})`
          : tab === "categories"
            ? `Categories (${categories.length})`
            : tab === "kv"
              ? "KV Prefs"
              : `Events (${eventEntries.length})`}
      </button>
    {/each}
  </nav>

  <!-- ─── TODOS TAB ─────────────────────────────────────────────────── -->
  {#if activeTab === "todos"}
    <section class="panel">
      <!-- Add form -->
      <div class="add-row">
        <input
          type="text"
          bind:value={newTodoText}
          placeholder="What needs to be done?"
          on:keydown={(e) => e.key === "Enter" && addTodo()}
        />
        <select bind:value={newTodoPriority} class="priority-select">
          <option value={1}>P1</option>
          <option value={2}>P2</option>
          <option value={3}>P3</option>
          <option value={4}>P4</option>
          <option value={5}>P5</option>
        </select>
        <button on:click={addTodo}>Add</button>
      </div>

      <!-- Filter pills -->
      <div class="filter-bar">
        <button
          class="pill"
          class:active={filterView === "all"}
          on:click={() => (filterView = "all")}
        >
          All ({allCount})
        </button>
        <button
          class="pill"
          class:active={filterView === "active"}
          on:click={() => (filterView = "active")}
        >
          Active ({activeCount})
        </button>
        <button
          class="pill"
          class:active={filterView === "completed"}
          on:click={() => (filterView = "completed")}
        >
          Done ({completedCount})
        </button>

        <span class="spacer" />

        <!-- Transactions: bulk actions -->
        <button class="bulk-btn" on:click={markAllComplete} title="Transaction: mark all as complete">
          ✓ Complete All
        </button>
        <button class="bulk-btn danger" on:click={clearCompleted} title="Transaction: delete all completed">
          ✕ Clear Done
        </button>
      </div>

      <!-- Todo list -->
      <div class="todo-list">
        {#if visibleTodos?.loading}
          <p class="hint">Loading…</p>
        {:else if visibleTodos?.error}
          <p class="error">Error: {visibleTodos.error.message}</p>
        {:else if todoData.length === 0}
          <p class="hint">No todos here yet.</p>
        {:else}
          {#each todoData as todo (todo.id)}
            <div class="todo-item" class:completed={todo.completed}>
              <input
                type="checkbox"
                checked={todo.completed}
                on:change={() => toggleTodo(todo)}
              />

              <span
                class="priority-dot"
                style="background:{priorityColor(todo.priority)}"
                title={priorityLabel(todo.priority)}
              />

              <span class="text">{todo.text}</span>

              <!-- Assigned tags -->
              {#if todo.tags && todo.tags.length > 0}
                <div class="todo-tags">
                  {#each todo.tags as tag (tag.id)}
                    <span class="todo-tag" style="background:{tag.color}" title={tag.name}>
                      {tag.name}
                      <button class="untag-btn" on:click={() => untagTodo(todo.id, tag.id)}>×</button>
                    </span>
                  {/each}
                </div>
              {/if}

              <!-- Relation: tag selector -->
              {#if categories.length}
                <select
                  class="tag-select"
                  value=""
                  on:change={(e) => {
                    const catId = e.currentTarget.value;
                    if (catId) tagTodo(todo.id, catId);
                    e.currentTarget.value = "";
                  }}
                >
                  <option value="" disabled>+ tag</option>
                  {#each categories as cat}
                    <option value={cat.id}>{cat.name}</option>
                  {/each}
                </select>
              {/if}

              <button
                class="delete-btn"
                on:click={() => deleteTodo(todo)}
              >
                ×
              </button>
            </div>
          {/each}
        {/if}
      </div>

      <div class="status-bar">
        {activeCount} remaining · {completedCount} completed ·
        mode: <strong>{currentMode}</strong>
      </div>
    </section>

  <!-- ─── CATEGORIES TAB ────────────────────────────────────────────── -->
  {:else if activeTab === "categories"}
    <section class="panel">
      <h2>Categories <small>(many-many relation with todos)</small></h2>

      <div class="add-row">
        <input
          type="text"
          bind:value={newCategoryName}
          placeholder="Category name"
          on:keydown={(e) => e.key === "Enter" && addCategory()}
        />
        <input type="color" bind:value={newCategoryColor} class="color-pick" />
        <button on:click={addCategory}>Add</button>
      </div>

      <div class="cat-list">
        {#if categories.length === 0}
          <p class="hint">No categories yet.</p>
        {:else}
          {#each categories as cat (cat.id)}
            <div class="cat-item">
              <span class="cat-dot" style="background:{cat.color}" />
              <span class="cat-name">{cat.name}</span>
              <code class="cat-id">{cat.id}</code>
              <button class="delete-btn" on:click={() => deleteCategory(cat)}>
                ×
              </button>
            </div>
          {/each}
        {/if}
      </div>
    </section>

  <!-- ─── KV PREFS TAB ──────────────────────────────────────────────── -->
  {:else if activeTab === "kv"}
    <section class="panel">
      <h2>KV Preferences <small>(client.kv API)</small></h2>
      <p class="hint">
        Values are stored via the built-in KV resource and exposed as reactive
        signals. They persist across sessions in IndexedDB and sync with the
        server (in sync mode).
      </p>

      <div class="kv-grid">
        <div class="kv-card">
          <h3>Theme</h3>
          <p>Current: <strong>{currentTheme}</strong></p>
          <div class="kv-actions">
            <button
              class:active={currentTheme === "dark"}
              on:click={() => setTheme("dark")}
            >
              Dark
            </button>
            <button
              class:active={currentTheme === "light"}
              on:click={() => setTheme("light")}
            >
              Light
            </button>
          </div>
        </div>

        <div class="kv-card">
          <h3>Default Sort</h3>
          <p>Current: <strong>{currentSort}</strong></p>
          <div class="kv-actions">
            <button
              class:active={currentSort === "createdAt:desc"}
              on:click={() => setSortPref("createdAt:desc")}
            >
              Newest first
            </button>
            <button
              class:active={currentSort === "createdAt"}
              on:click={() => setSortPref("createdAt")}
            >
              Oldest first
            </button>
            <button
              class:active={currentSort === "priority"}
              on:click={() => setSortPref("priority")}
            >
              By priority
            </button>
          </div>
        </div>
      </div>

      <div class="kv-raw">
        <h3>Raw KV Operations</h3>
        <pre><code>client.kv.get("pref:theme")   → {JSON.stringify(currentTheme)}
client.kv.get("pref:sort")    → {JSON.stringify(currentSort)}</code></pre>
      </div>
    </section>

  <!-- ─── EVENTS TAB ─────────────────────────────────────────────────── -->
  {:else if activeTab === "events"}
    <section class="panel">
      <h2>Event Bus <small>(client.subscribe)</small></h2>
      <p class="hint">
        Real-time stream of DataFn events (mutations, sync lifecycle). Also
        demonstrating the audit-log plugin.
      </p>

      <div class="event-split">
        <div class="event-col">
          <h3>Live Events</h3>
          {#if eventEntries.length === 0}
            <p class="hint">No events yet — perform a mutation or sync.</p>
          {:else}
            <div class="event-log">
              {#each eventEntries as ev}
                <div class="ev-row">
                  <span class="ev-time">{fmtTime(ev.ts)}</span>
                  <span class="ev-type">{ev.type}</span>
                  <span class="ev-detail">{ev.detail}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <div class="event-col">
          <h3>Plugin Audit Log</h3>
          {#if auditLog.length === 0}
            <p class="hint">No audit entries yet.</p>
          {:else}
            <div class="event-log">
              {#each auditLog as entry}
                <div class="ev-row">
                  <span class="ev-time">{fmtTime(entry.timestamp)}</span>
                  <span class="ev-type">{entry.phase}</span>
                  <span class="ev-detail">{entry.detail}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    </section>
  {/if}
</main>

<style>
  /* ── Theme ───────────────────────────────────────────────────────── */
  :global(:root) {
    --bg: #1a1a2e;
    --surface: #22223b;
    --surface2: #2a2a4a;
    --text: #e0e0f0;
    --text-muted: #8888aa;
    --accent: #646cff;
    --accent-hover: #535bf2;
    --danger: #f55;
    --border: #333358;
    --radius: 10px;
  }

  main.light {
    --bg: #f5f5fa;
    --surface: #ffffff;
    --surface2: #eeeef4;
    --text: #1a1a2e;
    --text-muted: #666688;
    --accent: #535bf2;
    --accent-hover: #3b3fd9;
    --border: #ccccdd;
  }

  :global(body) {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: "Inter", system-ui, -apple-system, sans-serif;
    min-height: 100vh;
  }

  main {
    max-width: 780px;
    margin: 0 auto;
    padding: 2rem 1.5rem 4rem;
  }

  /* ── Header ──────────────────────────────────────────────────────── */
  header {
    text-align: center;
    margin-bottom: 2rem;
  }

  h1 {
    font-size: 2.2rem;
    margin: 0 0 0.25rem;
    font-weight: 700;
  }

  .subtitle {
    color: var(--text-muted);
    font-size: 0.9rem;
    margin: 0 0 1.2rem;
  }

  .header-controls {
    display: flex;
    gap: 0.75rem;
    justify-content: center;
    flex-wrap: wrap;
  }

  .mode-btn,
  .theme-btn {
    padding: 0.5rem 1rem;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    font-size: 0.85rem;
    transition: all 0.15s;
  }

  .mode-btn.active {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }

  .mode-btn:hover,
  .theme-btn:hover {
    border-color: var(--accent);
  }

  /* ── Tabs ─────────────────────────────────────────────────────────── */
  .tabs {
    display: flex;
    gap: 0;
    border-bottom: 2px solid var(--border);
    margin-bottom: 1.5rem;
  }

  .tab {
    flex: 1;
    padding: 0.7rem 0.5rem;
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-weight: 600;
    font-size: 0.9rem;
    border-bottom: 2px solid transparent;
    margin-bottom: -2px;
    transition: all 0.15s;
    text-transform: capitalize;
  }

  .tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  .tab:hover {
    color: var(--text);
  }

  /* ── Panel ────────────────────────────────────────────────────────── */
  .panel {
    background: var(--surface);
    border-radius: var(--radius);
    padding: 1.5rem;
    border: 1px solid var(--border);
  }

  .panel h2 {
    margin: 0 0 0.5rem;
    font-size: 1.3rem;
  }

  .panel h2 small {
    color: var(--text-muted);
    font-weight: 400;
    font-size: 0.75rem;
  }

  /* ── Add row ──────────────────────────────────────────────────────── */
  .add-row {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .add-row input[type="text"] {
    flex: 1;
    padding: 0.7rem 0.9rem;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--surface2);
    color: var(--text);
    font-size: 0.95rem;
  }

  .add-row input[type="text"]:focus {
    outline: none;
    border-color: var(--accent);
  }

  .priority-select,
  .tag-select {
    padding: 0.5rem;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--surface2);
    color: var(--text);
    font-size: 0.85rem;
    cursor: pointer;
  }

  .color-pick {
    width: 40px;
    height: 40px;
    border: none;
    border-radius: var(--radius);
    cursor: pointer;
    background: none;
  }

  .add-row button,
  .bulk-btn {
    padding: 0.7rem 1.2rem;
    border-radius: var(--radius);
    border: none;
    background: var(--accent);
    color: #fff;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.85rem;
    transition: background 0.15s;
    white-space: nowrap;
  }

  .add-row button:hover,
  .bulk-btn:hover {
    background: var(--accent-hover);
  }

  .bulk-btn.danger {
    background: transparent;
    color: var(--danger);
    border: 1px solid var(--danger);
  }

  .bulk-btn.danger:hover {
    background: rgba(255, 80, 80, 0.12);
  }

  /* ── Filter bar ──────────────────────────────────────────────────── */
  .filter-bar {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }

  .pill {
    padding: 0.35rem 0.8rem;
    border-radius: 99px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.8rem;
    transition: all 0.15s;
  }

  .pill.active {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }

  .spacer {
    flex: 1;
  }

  /* ── Todo list ───────────────────────────────────────────────────── */
  .todo-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .todo-item {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.8rem 1rem;
    background: var(--surface2);
    border-radius: var(--radius);
    transition: opacity 0.15s;
  }

  .todo-item.completed .text {
    text-decoration: line-through;
    color: var(--text-muted);
  }

  .priority-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .text {
    flex: 1;
    font-size: 0.95rem;
  }

  .tag-select {
    max-width: 90px;
    font-size: 0.75rem;
    padding: 0.3rem 0.4rem;
  }

  .todo-tags {
    display: flex;
    gap: 0.25rem;
    flex-wrap: wrap;
    flex-shrink: 0;
  }

  .todo-tag {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    padding: 0.15rem 0.4rem;
    border-radius: 99px;
    font-size: 0.7rem;
    font-weight: 600;
    color: #fff;
    white-space: nowrap;
  }

  .untag-btn {
    background: transparent;
    border: none;
    color: rgba(255, 255, 255, 0.8);
    cursor: pointer;
    padding: 0;
    font-size: 0.85rem;
    line-height: 1;
    display: flex;
    align-items: center;
  }

  .untag-btn:hover {
    color: #fff;
  }

  .delete-btn {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0.3rem 0.5rem;
    font-size: 1.3rem;
    line-height: 1;
    border-radius: 6px;
    transition: all 0.15s;
  }

  .delete-btn:hover {
    background: rgba(255, 80, 80, 0.12);
    color: var(--danger);
  }

  .status-bar {
    margin-top: 1rem;
    color: var(--text-muted);
    font-size: 0.8rem;
    text-align: center;
  }

  .hint {
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .error {
    color: var(--danger);
    font-size: 0.85rem;
  }

  /* ── Category list ───────────────────────────────────────────────── */
  .cat-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin-top: 0.5rem;
  }

  .cat-item {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.7rem 1rem;
    background: var(--surface2);
    border-radius: var(--radius);
  }

  .cat-dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .cat-name {
    flex: 1;
    font-weight: 600;
  }

  .cat-id {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  /* ── KV prefs ────────────────────────────────────────────────────── */
  .kv-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    margin: 1rem 0;
  }

  .kv-card {
    background: var(--surface2);
    padding: 1rem;
    border-radius: var(--radius);
  }

  .kv-card h3 {
    margin: 0 0 0.4rem;
    font-size: 1rem;
  }

  .kv-card p {
    margin: 0 0 0.6rem;
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .kv-actions {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .kv-actions button {
    padding: 0.35rem 0.7rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.8rem;
    transition: all 0.15s;
  }

  .kv-actions button.active {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }

  .kv-raw {
    margin-top: 1rem;
  }

  .kv-raw h3 {
    font-size: 0.95rem;
    margin: 0 0 0.5rem;
  }

  .kv-raw pre {
    background: var(--surface2);
    padding: 1rem;
    border-radius: var(--radius);
    overflow-x: auto;
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  /* ── Event log ───────────────────────────────────────────────────── */
  .event-split {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    margin-top: 1rem;
  }

  .event-col h3 {
    font-size: 0.95rem;
    margin: 0 0 0.5rem;
  }

  .event-log {
    max-height: 350px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .ev-row {
    display: flex;
    gap: 0.5rem;
    font-size: 0.78rem;
    padding: 0.35rem 0.5rem;
    background: var(--surface2);
    border-radius: 6px;
    align-items: baseline;
  }

  .ev-time {
    color: var(--text-muted);
    font-family: monospace;
    flex-shrink: 0;
  }

  .ev-type {
    color: var(--accent);
    font-weight: 600;
    flex-shrink: 0;
  }

  .ev-detail {
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ── Responsive ──────────────────────────────────────────────────── */
  @media (max-width: 600px) {
    .kv-grid,
    .event-split {
      grid-template-columns: 1fr;
    }

    .filter-bar {
      flex-wrap: wrap;
    }
  }
</style>
