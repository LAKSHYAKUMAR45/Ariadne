# Knowledge Benchmark Baseline Report

- Benchmark ID: 8ad674d399b4065b3e0f94cb8d207e2b35881ac6e5b6e9ccb854e543dfcdc8ad
- Schema Version: knowledge-benchmark-report-v1
- Generated At: 2026-09-30T10:20:37.158Z
- Git Commit: 04464e9f3564fd2e0e89805973f235600ddea75a
- Git Dirty: no

## Gates

| Gate | Passed | Violations |
| --- | --- | --- |
| overall | yes | none |
| quality | yes | none |
| correctness | yes | none |
| privacy | yes | none |
| determinism | yes | none |

## Quality

| Metric | Value |
| --- | --- |
| Recall@1 | 10 / 10 (1.000000) |
| Recall@3 | 10 / 10 (1.000000) |
| Recall@10 | 10 / 10 (1.000000) |
| Mean Reciprocal Rank | 1.000000 |
| nDCG@10 | 1.000000 |
| Zero-result rate | 0 / 10 (0.000000) |
| Ambiguity rate | 0 / 10 (0.000000) |
| Exact-span citation rate | 10 / 10 (1.000000) |
| Typed-graph evidence rate | 10 / 10 (1.000000) |

## Performance observations

| Observation | Value |
| --- | --- |
| Policy | observational |
| Cold construction (ms) | 121.755 |
| Worker drain (ms) | 842.166 |
| Completed jobs per second | 9.499312 |
| Source bytes per second | 4861.272776 |
| Incremental update (ms) | 143.818 |
| Search latency p50 (ms) | 30.158 |
| Search latency p95 (ms) | 53.088 |
| Search latency p99 (ms) | 57.759 |
| SQLite main bytes | 2347008 |
| SQLite WAL bytes | 0 |
| SQLite SHM bytes | 32768 |
| SQLite total bytes | 2379776 |
| Storage amplification | 581.283830 |
| RSS start bytes | 82972672 |
| RSS peak bytes | 136777728 |
| RSS delta bytes | 53805056 |

Machine-dependent values are observational in baseline v1.

## Determinism

| Field | Value |
| --- | --- |
| Digest algorithm | sha256 |
| First run digest | b1cfd8438b93fffb84106d6207746d4c6c09180e412978a0d7aa70d89b8c5fb8 |
| Second run digest | b1cfd8438b93fffb84106d6207746d4c6c09180e412978a0d7aa70d89b8c5fb8 |
| Matched | yes |

## Environment

| Field | Value |
| --- | --- |
| Node | v20.20.2 |
| Platform | linux |
| Architecture | x64 |
| CPU model | AMD EPYC-Rome Processor |
| Logical CPU count | 16 |
| Total memory bytes | 67434610688 |
| Corpus version | naas-v1 |
| Corpus digest | 7725c7df9e23392a2554dfa7f50e8cf38360a9e6e66bf16a6b86535719e9d4b8 |
| Source count | 8 |
| Source bytes | 4094 |
| Required question count | 10 |
| Search warm-up rounds | 1 |
| Search timed rounds | 30 |
| Search sample count | 300 |

## Public benchmarks

| Benchmark | Status | Reason |
| --- | --- | --- |
| CodeSearchNet | not_measured | Not measured in the offline baseline; no reviewed adapter or dataset is bundled. |
| RepoBench | not_measured | Not measured in the offline baseline; no reviewed adapter or dataset is bundled. |
| BEIR/MTEB | not_measured | Not measured in the offline baseline; no reviewed adapter or dataset is bundled. |
| ALCE | not_measured | Not measured in the offline baseline; no reviewed adapter or dataset is bundled. |
| VIBE | not_measured | Not measured in the offline baseline; no reviewed adapter or dataset is bundled. |

