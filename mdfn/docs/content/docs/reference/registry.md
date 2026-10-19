---
title: "@mdfn/registry"
description: In-memory, host-controlled registry for extension packages and reusable editor profiles.
---

In-memory, host-controlled registry for extension packages and reusable editor profiles. Extension registration resolves the same dependency, conflict, security, and schema checks used by the core engine. Profile registration only checks the name, version, duplicates, and that its extensions exist; the full resolution runs when `profile()` looks the profile up.
