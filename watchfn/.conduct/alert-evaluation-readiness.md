# Alert condition evaluation

The standalone alert evaluator previously ignored declared time windows, selected
only the first metric for composite conditions, guessed metric identity from array
position, and reset triggered alerts when observations were missing. Four regression
cases reproduced those behaviors before this change.

Conditions now evaluate timestamped finite samples at one explicit observation time.
Threshold windows include both endpoints and exclude future samples. Composite
children select their own metric, including nested composites. A flat composite
input requires explicit metric labels; single-metric arrays may omit that label.
Threshold `type` is optional, matching the specification's shorthand. Invalid
conditions, nonpositive/unbounded windows, empty composites and excessive recursive
nesting reject explicitly.

The condition result distinguishes true, false and unknown. AND with a known false
child is false; OR with a known true child is true; otherwise missing child evidence
propagates unknown. The stateful evaluator reports `observed: false` and preserves
its state for unknown results. This avoids declaring recovery from missing data.
Aggregations reject nonfinite results. Anomaly samples are sorted by timestamp;
zero and negative baselines have defined behavior and at least two samples are
required. Anomaly history is supplied by the caller; there is no new implicit
history retention window.

## API migration

Provide epoch-millisecond `timestamp` on every sample. Previously accepted bare
`{ value }` samples cannot prove window membership and now yield no observation.
Composite arrays must identify each `metric`; positional inference was unsafe.
`evaluateResult()` exposes `matched: boolean | null`, value and dataPoints;
`evaluate()` retains the boolean convenience result. `AlertEvaluator` returns
`observed` alongside the current comparison result; inspect its alert state when
observations are missing. Evaluation still operates on caller-provided samples.

## Original scope still open

This fixes the evaluator foundation, not the public alert manager. `watch.alerts`
still lacks automatic metric-window querying, durable definitions/lifecycle,
notification outbox and configured delivery integration. Its acknowledge/note
methods and email sender remain placeholders. Original specification section 9
therefore remains incomplete, including autoResolve, escalation, actual channel
acceptance and restart guarantees. No external notifications were sent.

Validation: all203 core tests passed before the additional constant-decimal
anomaly regression; the final16 focused alert tests, TypeScript lint/typecheck and
runtime/declaration builds pass. Constant decimal samples at maximum sensitivity
now ignore mean-rounding noise using a small scale-relative numeric tolerance.
