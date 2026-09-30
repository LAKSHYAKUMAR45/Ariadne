# Knowledge Benchmark Baseline Report

- Benchmark ID: a0390fa1dd099b836f82ece061b1f28f218040202031171cc1fa9101ff496508
- Schema Version: knowledge-benchmark-report-v1
- Generated At: 2026-09-30T09:19:27.817Z
- Git Commit: 7d63cd44f6e382524e4ce96f0316a588426d7e0b
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
| Cold construction (ms) | 83.146 |
| Worker drain (ms) | 999.347 |
| Completed jobs per second | 8.005226 |
| Source bytes per second | 4096.674580 |
| Incremental update (ms) | 106.459 |
| Search latency p50 (ms) | 29.581 |
| Search latency p95 (ms) | 53.393 |
| Search latency p99 (ms) | 68.983 |
| SQLite main bytes | 2355200 |
| SQLite WAL bytes | 0 |
| SQLite SHM bytes | 32768 |
| SQLite total bytes | 2387968 |
| Storage amplification | 583.284807 |
| RSS start bytes | 80453632 |
| RSS peak bytes | 134520832 |
| RSS delta bytes | 54067200 |

Machine-dependent values are observational in baseline v1.

## Determinism

| Field | Value |
| --- | --- |
| Digest algorithm | sha256 |
| First run digest | b8fa793580e02eec2f8c5bbce496ed1dcf25a7020a02efebf510825ec2c2bd45 |
| Second run digest | b8fa793580e02eec2f8c5bbce496ed1dcf25a7020a02efebf510825ec2c2bd45 |
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

