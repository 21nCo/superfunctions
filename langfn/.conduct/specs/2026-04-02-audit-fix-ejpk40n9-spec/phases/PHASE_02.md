# Phase goal

Repair prompt management and structured-output parsing so prompt templates, registries, and schema-bound parsing behave deterministically in both languages.

# In scope

- `PromptTemplate`, `ChatTemplate`, and `FewShotPrompt` public exports.
- Prompt registry persistence and deterministic version lookup.
- Structured output parsing and canonical validation errors.
- Prompt/structured API parity between TypeScript and Python.

# Out of scope

- Tool execution, graph execution, and HTTP transport.
- Observability persistence beyond trace IDs already attached by the client layer.

# Deliverables

- `langfn/typescript/src/prompts/template.ts`
- `langfn/typescript/src/prompts/chat_template.ts`
- `langfn/typescript/src/prompts/few-shot.ts`
- `langfn/typescript/src/prompts/registry.ts`
- `langfn/typescript/src/prompts/index.ts`
- `langfn/typescript/src/structured/output.ts`
- `langfn/typescript/src/structured/index.ts`
- `langfn/typescript/tests/prompt-and-structured.test.ts`
- `langfn/python/langfn/prompts/template.py`
- `langfn/python/langfn/prompts/chat_template.py`
- `langfn/python/langfn/prompts/few_shot.py`
- `langfn/python/langfn/prompts/registry.py`
- `langfn/python/langfn/prompts/__init__.py`
- `langfn/python/langfn/structured/output.py`
- `langfn/python/langfn/structured/__init__.py`
- `langfn/python/tests/test_prompt_and_structured.py`
- `langfn/python/tests/test_prompts.py`

# Requirements covered

- `PROMPT-001`
- `PROMPT-002`
- `STRUCT-001`

# Implementation tasks

1. Export `PromptTemplate`, `ChatTemplate`, and `FewShotPrompt` from both languages using the names documented in `SPEC.md`.
2. Fix prompt-template internals so required variables are tracked explicitly and missing variables fail with canonical validation errors instead of attribute errors.
3. Implement deterministic chat message rendering and few-shot example ordering in both languages.
4. Refactor prompt registries to use shared DB abstractions, exact version lookup, deterministic `latest` resolution, and export parity.
5. Make structured output parsing validate against Zod in TypeScript and Pydantic in Python without mutating the raw provider payload.
6. Surface canonical schema/validation errors with field-level details for invalid JSON or invalid schema matches.
7. Add focused prompt/structured tests that cover success, missing variables, invalid JSON, schema mismatches, and registry `latest` resolution.

# Verification steps

1. Run `npm --prefix langfn/typescript test -- tests/prompt-and-structured.test.ts`.
   Expected outcome: prompt rendering, registry, and structured-output tests pass in TypeScript.
2. Run `python3 -m pytest langfn/python/tests/test_prompt_and_structured.py langfn/python/tests/test_prompts.py -q`.
   Expected outcome: Python prompt rendering, registry, and structured-output tests pass.
3. Run `PYTHONPATH=langfn/python python3 -c "from langfn.prompts import PromptTemplate, ChatTemplate; PromptTemplate('Hello {name}').format(name='Ada'); ChatTemplate.from_messages([('system', 'x'), ('user', '{msg}')]).format_messages(msg='hi')"` .
   Expected outcome: the smoke command succeeds and proves the documented prompt types are importable and callable.

# Stop condition

- Stop after prompt exports are stable, registry lookups are deterministic through shared DB abstractions, structured parsing returns canonical success/error payloads, and the verification steps pass.
