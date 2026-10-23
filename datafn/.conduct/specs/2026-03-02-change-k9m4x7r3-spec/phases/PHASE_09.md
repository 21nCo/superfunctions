# PHASE_09: Merge Python SDK Docs into Main Server Docs Using Tabbed Code Blocks

## Phase Goal

Remove the separate Python sidebar section and integrate all Python SDK documentation into the main server and database docs using Fumadocs tabbed code blocks (`<Tabs>`/`<Tab>`). Users will see TypeScript and Python examples side by side.

## In Scope

- PY-001: Merge python/setup.mdx into server/setup.mdx
- PY-002: Merge python/server.mdx into server/routes.mdx and server/setup.mdx
- PY-003: Merge python/database.mdx into database/adapters.mdx
- PY-004: Merge python/handlers.mdx into server/authorization.mdx or server/routes.mdx
- PY-005: Remove python/ sidebar section from top-level meta.json

## Out of Scope

- Creating new Python SDK functionality
- Modifying Python SDK source code
- Changing TypeScript example content

## Deliverables

| File | Action |
|---|---|
| `datafn/docs/content/docs/documentation/server/setup.mdx` | UPDATE — add Python setup examples in tabs |
| `datafn/docs/content/docs/documentation/server/routes.mdx` | UPDATE — add Python route handler examples in tabs |
| `datafn/docs/content/docs/documentation/database/adapters.mdx` | UPDATE — add Python database adapter examples in tabs |
| `datafn/docs/content/docs/documentation/server/authorization.mdx` | UPDATE — add Python authorization examples in tabs |
| `datafn/docs/content/docs/meta.json` | UPDATE — remove `"python"` from pages array |
| `datafn/docs/content/docs/python/*.mdx` | DELETE or ARCHIVE — no longer referenced from sidebar |

## Requirements Covered

PY-001, PY-002, PY-003, PY-004, PY-005

## Implementation Tasks

### Preparation

1. [ ] Read all Python doc files to understand content:
   - `python/index.mdx` — overview/intro
   - `python/setup.mdx` — installation, config, schema definition in Python
   - `python/server.mdx` — create_datafn_server, routes, FastAPI/Starlette/Django integration
   - `python/database.mdx` — database adapters (SQLAlchemy, etc.)
   - `python/handlers.mdx` — custom handlers, authorization callbacks
2. [ ] Verify Fumadocs Tabs import works in the project:
   ```typescript
   import { Tab, Tabs } from "fumadocs-ui/components/tabs";
   ```

### PY-001: Merge python/setup.mdx → server/setup.mdx

3. [ ] Open `documentation/server/setup.mdx`
4. [ ] Add `import { Tab, Tabs } from "fumadocs-ui/components/tabs";` at the top (after frontmatter)
5. [ ] For the installation section, wrap in tabs:
   ```mdx
   <Tabs items={["TypeScript", "Python"]}>
     <Tab value="TypeScript">
       ```bash
       npm install @datafn/server
       ```
     </Tab>
     <Tab value="Python">
       ```bash
       pip install datafn
       ```
     </Tab>
   </Tabs>
   ```
6. [ ] For the server creation/configuration section, add Python tab:
   ```mdx
   <Tabs items={["TypeScript", "Python"]}>
     <Tab value="TypeScript">
       ```typescript
       // existing TypeScript example
       ```
     </Tab>
     <Tab value="Python">
       ```python
       from datafn import create_datafn_server
       # Python example from python/setup.mdx
       ```
     </Tab>
   </Tabs>
   ```
7. [ ] For schema definition, add Python tab showing Python schema syntax
8. [ ] Add a brief note near the top: "DataFn supports both TypeScript (Node.js) and Python servers. Use the language tabs to switch between examples."

### PY-002: Merge python/server.mdx → server/routes.mdx + server/setup.mdx

9. [ ] Open `documentation/server/routes.mdx`
10. [ ] Add Tabs import if not already present
11. [ ] For route definitions/handlers, add Python tabs showing:
    - FastAPI integration
    - Starlette integration
    - Django integration (if documented)
12. [ ] Use nested approach if needed: outer tab for TypeScript/Python, inner content for Python framework variants:
    ```mdx
    <Tabs items={["TypeScript", "Python (FastAPI)", "Python (Starlette)"]}>
      <Tab value="TypeScript">...</Tab>
      <Tab value="Python (FastAPI)">...</Tab>
      <Tab value="Python (Starlette)">...</Tab>
    </Tabs>
    ```

### PY-003: Merge python/database.mdx → database/adapters.mdx

13. [ ] Open `documentation/database/adapters.mdx`
14. [ ] Add Tabs import
15. [ ] For database adapter setup, add Python tab showing:
    - SQLAlchemy adapter setup
    - Connection configuration
    - Any Python-specific adapter details
16. [ ] Preserve all existing TypeScript content unchanged

### PY-004: Merge python/handlers.mdx → server/authorization.mdx

17. [ ] Open `documentation/server/authorization.mdx`
18. [ ] Add Tabs import
19. [ ] For authorization callback examples, add Python tab:
    ```mdx
    <Tabs items={["TypeScript", "Python"]}>
      <Tab value="TypeScript">
        ```typescript
        authorize: async (ctx, operation) => { ... }
        ```
      </Tab>
      <Tab value="Python">
        ```python
        async def authorize(ctx, operation):
            ...
        ```
      </Tab>
    </Tabs>
    ```
20. [ ] If `python/handlers.mdx` covers topics beyond authorization (e.g., custom route handlers), merge those into the appropriate server doc pages

### PY-005: Remove Python sidebar section

21. [ ] Update `datafn/docs/content/docs/meta.json`:
    ```json
    { "title": "DataFn", "pages": ["index", "documentation", "dfql", "cli", "reference"] }
    ```
    (remove `"python"`)
22. [ ] Delete the Python doc files (or move to an `_archive` folder if preferred):
    - `python/index.mdx`
    - `python/setup.mdx`
    - `python/server.mdx`
    - `python/database.mdx`
    - `python/handlers.mdx`
    - `python/meta.json`
23. [ ] Search all docs for links to `/docs/python/...` and update them to point to the new locations in server/database docs

### Cross-check

24. [ ] Verify no remaining references to Python sidebar pages in any doc file:
    ```bash
    grep -r "/docs/python/" datafn/docs/content/
    ```

## Verification Steps

1. Doc site builds:
   ```bash
   cd datafn/docs && npm run build
   ```
2. No "Python" section in sidebar.
3. Python examples visible via tabs in:
   - Server setup page
   - Server routes page
   - Database adapters page
   - Server authorization page
4. All Python content from original files is preserved in the merged docs.
5. No broken links to `/docs/python/...`.

## Stop Condition

- Python sidebar section removed from top-level navigation.
- All Python SDK content accessible via tabbed code blocks in main server/database docs.
- Doc site builds successfully.
- No broken links.
- All Python examples render correctly within tabs.
