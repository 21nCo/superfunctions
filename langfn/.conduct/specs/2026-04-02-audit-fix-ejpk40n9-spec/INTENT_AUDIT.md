# Intent Inventory

1. LangFn MUST exist as a comprehensive AI development SDK for LLM workflow needs.
2. LangFn MUST follow repo-wide superfunctions conventions from `AGENTS.md`.
3. LangFn MUST provide both TypeScript and Python SDKs.
4. LangFn MUST combine orchestration, workflows, model abstraction, tools, observability, prompt management, and related AI workflow capabilities.
5. LangFn MUST provide model abstraction across major providers and local models.
6. LangFn MUST provide prompt templates, chat templates, few-shot support, and prompt registries.
7. LangFn MUST provide tool/function-calling support and agent abstractions.
8. LangFn MUST provide orchestration and graph workflows.
9. LangFn MUST provide observability with watchfn integration.
10. LangFn MUST provide structured output support.
11. LangFn MUST provide streaming support.
12. LangFn MUST provide retrieval and memory support without violating superfunctions package boundaries.
13. LangFn MUST provide evaluation and experimentation support.
14. LangFn MUST expose framework-agnostic HTTP integrations.
15. LangFn MUST be production ready, including retries, errors, rate limits, security, scalability, and packaging correctness.
16. LangFn MUST use shared superfunctions packages instead of duplicating shared infrastructure where those abstractions already exist.
17. LangFn MUST address the audit findings around packaging and abstraction.
18. LangFn MUST address the audit findings around public API/export breakage.
19. LangFn MUST address the audit findings around broken TypeScript tool calling.
20. LangFn MUST address the audit findings around trace correctness and feedback/query storage.
21. LangFn MUST address the audit findings around security hardening.
22. LangFn MUST address the audit findings around performance and scalable retrieval.
23. LangFn MUST address the audit findings around code duplication and maintainability.
24. LangFn MUST ship with runnable documentation and release verification.

# Coverage Matrix

| Intent item | SPEC.md coverage | Requirement IDs | Test vectors |
| --- | --- | --- | --- |
| 1 | Overview; Goals / Non-goals | PKG-001, API-001, QUAL-001 | TV-PKG-001, TV-API-001, TV-QUAL-001 |
| 2 | Overview; Compatibility / versioning strategy | PKG-001, PKG-002, ENG-001 | TV-PKG-001, TV-PKG-002, TV-ENG-001 |
| 3 | Overview; Public API | PKG-001, API-001, QUAL-001 | TV-PKG-001, TV-API-001, TV-QUAL-001 |
| 4 | Overview; Public API; Semantics | API-001, ORCH-001, GRAPH-001, AGENT-001, OBS-001 | TV-API-001, TV-ORCH-001, TV-GRAPH-001, TV-AGENT-001, TV-OBS-001 |
| 5 | Public API; Semantics | MODEL-001, MODEL-002 | TV-MODEL-001, TV-MODEL-002 |
| 6 | Public API; Semantics | PROMPT-001, PROMPT-002, STRUCT-001 | TV-PROMPT-001, TV-PROMPT-002, TV-STRUCT-001 |
| 7 | Public API; Semantics; Security | TOOL-001, TOOL-002, AGENT-001, AGENT-002 | TV-TOOL-001, TV-TOOL-002, TV-AGENT-001, TV-AGENT-002 |
| 8 | Public API; Semantics | ORCH-001, GRAPH-001 | TV-ORCH-001, TV-GRAPH-001 |
| 9 | Observability | OBS-001, OBS-002 | TV-OBS-001, TV-OBS-002 |
| 10 | Public API; Data formats / protocol | STRUCT-001 | TV-STRUCT-001 |
| 11 | Data formats / protocol; Invariants | STREAM-001 | TV-STREAM-001 |
| 12 | Overview; Semantics | MEM-001, RAG-001 | TV-MEM-001, TV-RAG-001 |
| 13 | Public API; Observability | EVAL-001 | TV-EVAL-001 |
| 14 | Public API; Data formats / protocol | HTTP-001, HTTP-002 | TV-HTTP-001, TV-HTTP-002 |
| 15 | Security; Limits / caps; Observability; Compatibility / versioning strategy | MODEL-002, OBS-001, OBS-002, HTTP-002, PERF-001, SEC-001, QUAL-001 | TV-MODEL-002, TV-OBS-001, TV-OBS-002, TV-HTTP-002, TV-PERF-001, TV-SEC-001, TV-QUAL-001 |
| 16 | Overview; Security; Compatibility / versioning strategy | PKG-001, HTTP-002, PERF-001, SEC-001, ENG-001 | TV-PKG-001, TV-HTTP-002, TV-PERF-001, TV-SEC-001, TV-ENG-001 |
| 17 | Overview; Compatibility / versioning strategy | PKG-001, PKG-002, QUAL-001 | TV-PKG-001, TV-PKG-002, TV-QUAL-001 |
| 18 | Public API; Compatibility / versioning strategy | PKG-001, API-001, PROMPT-001, OBS-001 | TV-PKG-001, TV-API-001, TV-PROMPT-001, TV-OBS-001 |
| 19 | Semantics | TOOL-001, AGENT-001 | TV-TOOL-001, TV-AGENT-001 |
| 20 | Invariants; Observability | OBS-001, OBS-002, HTTP-001 | TV-OBS-001, TV-OBS-002, TV-HTTP-001 |
| 21 | Security | TOOL-002, HTTP-002, SEC-001 | TV-TOOL-002, TV-HTTP-002, TV-SEC-001 |
| 22 | Overview; Semantics; Limits / caps | RAG-001, PERF-001 | TV-RAG-001, TV-PERF-001 |
| 23 | Compatibility / versioning strategy | ENG-001 | TV-ENG-001 |
| 24 | Goals / Non-goals; Compatibility / versioning strategy | QUAL-001 | TV-QUAL-001 |

No missing intent items.
