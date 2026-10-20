# Shared targeting semantics and migration

2026-10-20. TS/Python segment rules and inline flag constraints now share explicit
JSON/text/numeric behavior. The original `startsWith` operator is supported in
both SDK types, runtime validators, signed configuration and admin round trips.
All existing operator names remain available.

## Contract

| Operators | Behavior |
| --- | --- |
| `equals`, `does_not_equal` | Type-sensitive JSON structural equality: booleans, numbers and strings are distinct; object key order is ignored, array order matters. Shared numeric precision follows finite JavaScript IEEE-754 numbers, including when Python supplies integers. |
| `in`, `not_in` | Same structural equality against a JSON array. A non-array operand or invalid JSON is no match, including for the negative operator. |
| `contains`, `does_not_contain`, `startsWith` | Both operands must be strings. Case-sensitive UTF-16 code-unit matching preserves existing JS string semantics, including paired/lone surrogates. No object, array, boolean or number stringification. |
| `gt`, `gte`, `lt`, `lte` | Finite numbers or decimal strings. Decimal strings permit an optional sign, fraction and exponent, and surrounding ASCII whitespace. Booleans, empty strings, arrays, hexadecimal forms, Unicode digits and nonfinite values are no match. |
| `regex` | String trait and string pattern only; invalid patterns are no match. Existing native JS/Python regex engines remain in use; dialect equivalence and execution-time bounds are not claimed. |
| `exists`, `does_not_exist` | Presence retains existing null/missing semantics; false, zero and empty string are present. Other operators return false for missing/null traits. |

Fields remain literal own trait keys, not nested path expressions. TS inherited
properties/getters are not evaluated as trait values. Invalid/non-JSON operands
fail closed rather than making a negated comparison true. The strict JSON helper
was extracted to neutral `utils/json` modules and reused by prerequisites and
segments; flags and segments do not import each other through a new cycle.
Native Python strings/object keys containing an explicit surrogate pair compare
the same as the equivalent non-BMP character. A Python object with two keys that
collapse to the same UTF-16 key is invalid: configuration replacement rejects it
atomically, and trait comparisons (including negative operators) fail closed.
Python UTF-16 conversion is shared with the existing rollout hash implementation;
its existing golden hash vectors remain unchanged.

## Assignment compatibility

This is a deliberate targeting behavior correction, not an assignment-neutral
refactor. Review existing segment and inline flag rules before upgrading either
SDK, and upgrade both languages together. Config signatures/ETags certify bytes,
not the semantics of the SDK version that evaluates those bytes.

| Existing condition | Previous behavior | Current shared behavior / migration |
| --- | --- | --- |
| numeric trait `1` equals string `"1"` | String coercion could match in both SDKs. | No match. Normalize trait type explicitly or configure the intended numeric/string value. |
| boolean `true` equals string `"true"` | JS matched; Python did not because native string spelling differs. | No match in either SDK. Use a boolean rule for a boolean trait. |
| boolean `true` in `[1]` | Python membership matched; JS did not. | No match in either SDK. |
| structurally equal JSON object in an array | Python compared structure; JS used reference identity. | Matches structurally in both SDKs. Different objects no longer compare equal merely because JS stringifies them alike. |
| numeric/boolean trait used with contains or regex | Both SDKs stringified, with language-specific spellings. | No match. Supply an intentional string trait instead. |
| numeric comparisons on boolean/empty/hex/nondecimal inputs | Language-specific conversions could match. | No match. Existing documented decimal numeric-string comparisons such as `"25" >= 18` remain supported. |
| Python substring/prefix of part of a surrogate pair | Python code-point matching differed from JS code-unit matching. | Python now matches JS UTF-16 behavior. Ordinary Unicode strings retain expected case-sensitive matching. |

This does not introduce a legacy coercion mode. Existing prerequisites already
used strict JSON equality; their valid configured JSON comparison contract is
preserved. Null/missing behavior and supported operator names are retained.

## Evidence

One shared JSON fixture, `python/tests/fixtures/segment-semantics.json`, drives
both SDK tests and actual signed HTTP integration. Each vector exercises both
segment references and inline constraints; cases include type distinctions,
structural equality, negative operators, false/zero/empty/missing values, decimal
strings, invalid inputs, prefixes, portable regex patterns and surrogate text.
Additional runtime tests cover cycles, nonfinite values and non-JSON objects.

The service test publishes the fixture's flags/segments to real SQLite, verifies
signed refresh in the TS and Python SDKs, then evaluates every vector. It also
rejects an unknown operator update without invalidating the prior verified ETag.
Admin round trips retain `startsWith` in both segment and flag constraints.
Fresh npm consumers exercise signed publication/refresh and prefix targeting with
strict ESM/CJS declarations. Fresh installed Python wheel tests include the same
shared fixture; source aliases do not substitute for that package check. Actual
Chrome 154.0.8037.58 verifies signed refresh and prefix targeting, including
rejecting a boolean trait for a string prefix, alongside existing CORS/lifecycle
checks. TS, Python source/wheel, service native and admin suites plus all three
TypeScript package typechecks pass.

## Remaining original requirements

The specification names range, geo and time-window operators without defining
range inclusivity/value shape, geography representation or clock/timezone rules;
those contracts and implementations remain open. Event-derived segments, full
regex dialect parity and safe execution bounds remain open. This change does not
complete identity persistence, messaging/survey caps, framework hooks, owner/tag
administration, durable offline behavior or any other original milestone.
