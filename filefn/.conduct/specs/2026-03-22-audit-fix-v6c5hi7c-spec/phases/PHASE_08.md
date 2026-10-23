# PHASE_08

- Phase goal: Replace Nucleus read/render flows with FileFn viewer resolution and run the temporary dual-read cutover window.
- In scope / Out of scope
  - In scope: file view/store replacement, dual-read compatibility resolution, render/view adoption, local preview integration, read-path migration.
  - Out of scope: final deletion of compatibility code and final documentation cleanup.
- Deliverables
  - `/Users/serro/Documents/dev/n/nucleus/client/components/files/file.store.ts`
  - `/Users/serro/Documents/dev/n/nucleus/client/components/files/FileView.svelte`
  - new Nucleus FileFn adapter components/helpers under `/Users/serro/Documents/dev/n/nucleus/client/components/files/`
  - any temporary compatibility resolver under `/Users/serro/Documents/dev/n/nucleus/client/stores/` or `/Users/serro/Documents/dev/n/nucleus/client/utils/`
  - targeted Nucleus tests and manual smoke instructions
- Requirements covered
  - `VIEW-001`
  - `VIEW-002`
  - `CLIENT-002`
  - `MIG-002`
  - `NUCLEUS-001`
  - `BUILD-001`
- Implementation tasks
  1. Replace legacy signed-URL refresh logic with FileFn render/download resolution.
  2. Add compatibility resolution for legacy IDs during the temporary dual-read window.
  3. Route local pending file previews through FileFn viewer resolution.
  4. Validate image, PDF, audio, and generic file display behaviors in Nucleus.
  5. Add tests/manual smoke for post-migration read flows.
- Verification steps
  - `npm --prefix /Users/serro/Documents/dev/n/nucleus/tests test`
  - `npm --prefix /Users/serro/Documents/dev/n/nucleus run dev:nucleus`
  - Manual expected outcome: avatar, cover, memotron capture, markdown media grid, embed download, and file viewing all work with native FileFn IDs; local pending files preview immediately.
- Stop condition
  - Report the compatibility resolver entry points, the dual-read removal checklist, and any manual smoke evidence gathered.
