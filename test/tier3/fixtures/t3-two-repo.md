# T3-SUM: two repos

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
  org/other:
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
repo: org/other
depends_on: []
foundation: false
owns: ["src/other.ts"]
new_paths: ["test/other.test.ts"]
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
acceptance: ["the exported constant `other` in src/other.ts is 1 (it is 0 today)"]
```
