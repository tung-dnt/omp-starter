# T3-SUM: held checks

```yaml plan
id: T3-SUM
kind: story
shared_paths: []
checks:
  org/fixture:
    test: 'echo run >> "$HOME/t3-checks.log"; bun test; rc=$?; n=$(wc -l < "$HOME/t3-checks.log"); while [ -e "$HOME/t3-hold-$n" ]; do sleep 0.1; done; exit $rc'
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
depends_on: ["T3-SUM-T01"]
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
size: small
required_tests: []
acceptance: ["max(xs) returns the largest element of a non-empty number array"]
```
