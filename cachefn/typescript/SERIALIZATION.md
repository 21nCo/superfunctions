# Cache value serialization

`deserialize(serialize(value))` preserves supported values: null, undefined,
strings, booleans, numbers (including NaN, infinities and negative zero), bigint,
Date (including invalid dates), RegExp source/flags/nonnegative integer lastIndex,
arrays (including holes), plain objects, null-prototype dictionaries, Maps and Sets.
Object properties named `__type`, `__proto__`, `format` or `value` remain data.
Own undefined properties remain present. Shared references are copied by value;
object identity across different branches is not preserved.

The wire format is a versioned `cachefn/1` envelope containing a tagged tree.
Each user object is encoded as key/value pairs, so user fields cannot collide
with internal type tags. Property descriptors and prototypes beyond the plain
object/null-prototype distinction are not serialized. Arrays serialize indexed
elements; collections and Date/RegExp serialize their built-in value/state,
not additional attached properties. Plain object getters are evaluated during
serialization, as with JSON.stringify.

Functions, symbols, enumerable symbol keys on ordinary objects, custom class
instances and cyclic graphs are unsupported and throw TypeError. Memory caches
can still hold these values: `estimateSize` falls back to a cycle-safe estimate
of inspectable data without invoking getters during that fallback. Its number
is approximate and excludes engine/object overhead; it is not a memory quota.

`deserialize` also accepts ordinary JSON without type revival. The earlier
unversioned `__type` representation cannot distinguish user data from metadata,
so old marker-shaped objects remain ordinary objects. Persisted payloads from
that format should be regenerated or migrated explicitly. A JSON object shaped
exactly like the versioned envelope is interpreted as that wire format; wrap
user values with `serialize` before calling `deserialize` to guarantee round trips.
Malformed versioned nodes throw rather than partially reviving data.
