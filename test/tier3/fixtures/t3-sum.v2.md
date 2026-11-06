# T3-SUM: tier-3 fixture story

Fix `sum` and add `max`. Two independent tasks, so concurrency 2 is exercised.

```yaml plan
id: T3-SUM
kind: story
shared_paths: []
checks:
  org/fixture:
    test: "bun test"
    test_files: "bun test {files}"
    typecheck: ""
    lint: ""
```

```yaml task
id: T3-SUM-T01
repo: org/fixture
depends_on: []
foundation: false
owns: ["src/sum.ts"]
new_paths: ["test/sum.test.ts"]
reads: []
risk:
  shared_state: {value: no}
  external_io: {value: no}
  retries: {value: no}
  concurrent_writers: {value: no}
  non_idempotent_effects: {value: no}
  async_messaging: {value: no}
  multi_step_saga: {value: no}
  sensitive_data: {value: no}
lld_required: false
security_review: false
lld_skip_reason: ""
size: small
required_tests: []
acceptance: ["sum(a, b) returns a + b for any two numbers"]
```

```yaml task
id: T3-SUM-T02
repo: org/fixture
depends_on: []
foundation: false
owns: []
new_paths: ["src/max.ts", "test/max.test.ts"]
reads: []
risk:
  shared_state: {value: no}
  external_io: {value: no}
  retries: {value: no}
  concurrent_writers: {value: no}
  non_idempotent_effects: {value: no}
  async_messaging: {value: no}
  multi_step_saga: {value: no}
  sensitive_data: {value: no}
lld_required: false
security_review: false
lld_skip_reason: ""
size: normal
required_tests: []
acceptance: ["max(xs) returns the largest element of a non-empty number array (src/max.ts does not exist yet: the tests are written first and must fail because it is missing, which is expected)"]
```

Revision 2: the acceptance wording was reviewed.
