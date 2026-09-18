# dram-controller: a DRAM controller policy for LLM decode, scored in Ramulator 2.0

**Level:** L2 (cycle-accurate simulation, evaluator tier E1). **Objective:** `cycles`, lower is better.
**Time budget:** 120 s per trace. **Status:** first L2 challenge, measured on 2026-09-07.

## What the challenge is

An accelerator is decoding tokens from a language model. Decode is memory bound: every step reads all of the
model's weights once, and reads the whole KV cache of every sequence in the batch. The chip is waiting on DRAM.

The DRAM controller decides how to serve that traffic: whether to keep a row open after a read or precharge it,
how addresses spread over channels, banks and rows, and when to drain writes. Those choices are the submission.
Ramulator 2.0 replays the workload cycle by cycle and reports how many DRAM cycles it took. Fewer cycles means
more of the DRAM's bandwidth reached the accelerator.

The hardware is fixed: DDR4, `DDR4_8Gb_x8` devices, 4 channels, 2 ranks, `DDR4_3200AA` timings, 64-byte
transactions (Ramulator's DDR4 model: prefetch 8 on a 64-bit channel). tCK is 625 ps. Peak is one 64-byte
transaction per channel per 4 cycles, 102.4 GB/s for the system.

## Objective

`cycles` is Ramulator's `memory_system_cycles`: the number of memory-system ticks until the trace's last request is
accepted by a controller queue. The trace frontend (`LoadStoreTrace`) offers the next request eight times per
DRAM cycle and stalls while the target controller's 32-entry read or write queue is full, so the count is set by
how fast the controller drains the queues, which is the effective bandwidth on this workload. Lower is better.

Why this and not average read latency: Ramulator's `avg_read_latency_N` divides by send attempts, and a rejected
send counts as an attempt, so the number moves with queue pressure in a way that has nothing to do with the
policy. The harness reports a corrected mean (`readLatencyAvg`, summed latency over accepted reads) and the
row-buffer hit rate (`hitRate`) as diagnostics. Neither is the objective.

The objective is an integer, deterministic (Ramulator has no randomness in this configuration) and reproduced by
a second run before a score counts.

## The workload

`gen-trace.mjs` writes a few decode steps as one DRAM request per line. Per layer, per step:

1. Attention phase. The layer's attention weights (40 percent of the layer, 1.2 MB) stream sequentially while
   four attention engines each walk the KV pages of their sequences (eight sequences, two per engine). Pages are
   16 tokens, 2 KB for K and 2 KB for V, scattered at random inside two 512 MB pools. The streams are interleaved
   in bursts of 2 to 8 requests, the way independent engines contend on a shared memory system.
2. The new token's K and V are written into the tail of each sequence's last page (4 writes per sequence).
3. MLP phase. The remaining 1.8 MB of the layer's weights stream as two side-by-side streams (up and down
   projections).

Eight layers, 24 MB of weights, four steps. Context lengths start between 256 and 2048 tokens and grow by one
per step, so the same pages are read again every step and a new page is allocated when a sequence crosses a
16-token boundary. Reads are 99.96 percent of the trace, which is what decode looks like.

The public trace is seed 1: 2,913,280 requests (2,912,256 reads, 1,024 writes), 44 MB on disk. It is not committed;
`node gen-trace.mjs --seed 1` recreates it byte for byte in about a second. The hidden trace is another seed with
different weight and pool offsets, context lengths, page placement and burst sizes. The model shape is the same.

## What a submission is

One JSON document (`//` and `/* */` comments allowed). Not code. Every key is optional; a missing key takes the
baseline value.

```json
{
  "scheduler": "FRFCFS",
  "refresh": "AllBank",
  "row_policy": { "impl": "ClosedRowPolicy", "cap": 4 },
  "addr_mapper": "RoBaRaCoCh",
  "wr_low_watermark": 0.2,
  "wr_high_watermark": 0.8
}
```

| Key | Allowed | What it does in Ramulator 2.0 |
| --- | --- | --- |
| `scheduler` | `FRFCFS` | First-ready, first-come-first-served. The only scheduler the Generic controller has. |
| `refresh` | `AllBank` | All-bank refresh every tREFI. The only refresh manager the Generic controller has. |
| `row_policy.impl` | `OpenRowPolicy`, `ClosedRowPolicy` | Open leaves a row open until a conflict. Closed precharges a bank after `cap` column accesses. |
| `row_policy.cap` | integer 1 to 4096 | Only with `ClosedRowPolicy`. |
| `addr_mapper` | `RoBaRaCoCh`, `ChRaBaRoCo`, `MOP4CLXOR` | Which address bits pick the channel, rank, bank group, bank, row, column. RoBaRaCoCh interleaves channels at 64 B; ChRaBaRoCo puts the channel in the top bits; MOP4CLXOR interleaves 256 B per channel and XORs bank bits with column bits. |
| `wr_low_watermark`, `wr_high_watermark` | numbers in [0, 1], low below high | The controller enters write-drain mode when the write queue passes `high` (or the read queue is empty) and leaves it below `low`. |

Anything else (another key, a plugin list, a value outside the range, a scheduler that exists only for
Ramulator's BlockHammer controller) is rejected by `loadPolicySource()` before Ramulator starts.

`scheduler` and `refresh` have one value each. They are in the contract so the list can grow (a later Ramulator
or a patched build) without changing the document shape. In this build they are not levers.

## Constraints

- Each trace must finish inside 120,000 ms; the harness kills Ramulator at the budget and the run is invalid.
- The hardware block is not part of the submission and cannot be changed.
- The harness checks that Ramulator accepted exactly as many requests as the trace has lines.
- Two runs of the same document must return the same `cycles` and the same `fingerprint` (a hash of every
  statistic Ramulator printed, sorted so map order does not matter). Identical fingerprints mean identical policies.

## Measured numbers (Apple silicon laptop, 2026-09-07)

| Document | Trace | cycles | hitRate | readLatencyAvg | GB/s | wall |
| --- | --- | --- | --- | --- | --- | --- |
| baseline (`baseline.js`) | public, seed 1 | 6,230,455 | 0.731 | 305.5 | 47.9 | 21.8 s |
| baseline, second run | public, seed 1 | 6,230,455 (same fingerprint) | 0.731 | 305.5 | 47.9 | 21.5 s |
| `examples/dram-open-row.json` | public, seed 1 | 3,740,736 | 0.913 | 205.4 | 79.8 | 16.4 s |
| baseline | hidden | 6,079,538 | 0.732 | 313.3 | 45.7 | 22.0 s |
| `examples/dram-open-row.json` | hidden | 3,557,633 | 0.919 | 196.1 | 78.1 | 15.3 s |

Other single-knob points on the public trace, from the sweep that picked the example: `MOP4CLXOR` with the
baseline closed-row policy 3,915,084; `ClosedRowPolicy` cap 16 4,187,717; cap 64 3,818,153; open row plus
`MOP4CLXOR` 3,209,999; `ChRaBaRoCo` 38,520,211 in 64 s (every stream lands in one channel). The open row plus
`MOP4CLXOR` point shows the knobs combine; that is where the frontier starts.

## Running it locally

```
export DMI_RAMULATOR_BIN=/path/to/ramulator2      # built from the pinned commit, see below
node coordinator/challenges/dram-controller/gen-trace.mjs --seed 1
node coordinator/challenges/dram-controller/harness.js examples/dram-open-row.json
DMI_RAMULATOR_BIN=... node --test test/dram.test.mjs   # skips the Ramulator tests when the variable is unset
```

The harness writes a config YAML to a temp directory, runs `ramulator2 -f config.yaml`, parses the YAML stats
block on stdout, and deletes the temp directory.

## Provenance

- Simulator: Ramulator 2.0, https://github.com/CMU-SAFARI/ramulator2 MIT license, commit
  `5e58d25f1a6efbbe6a4dceb42025d4af43fc75c6` ("Fix PRAC timing parameters", 2026-01-06). This is the last commit
  of the 2.0 line. The current HEAD (2.1, September 2026) replaced the YAML command line with a Python-scripted
  configuration and has no standalone binary, so the challenge pins 2.0.
- Build: `cmake .. -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 && make`. The policy flag is
  needed because the fetched yaml-cpp 0.7.0 declares a CMake minimum that CMake 4 refuses. Apple clang 17 also
  needs `.template as<T>()` in `src/base/param.h` (one sed, no behavior change); gcc accepts the original.
- Ramulator 2.0 facts the harness depends on, each checked by running the binary: the `-f` flag and YAML shape,
  the `LoadStoreTrace` format (`LD|ST <addr>`, hex with `0x` or decimal, one per line, no comments), the stats
  block layout (`memory_system_cycles`, `total_num_read_requests`, per-channel `row_hits_N`, `row_misses_N`,
  `row_conflicts_N`, `read_latency_N`), and which knobs the Generic controller accepts. `ClosedRowPolicy` needs a
  DRAM model that defines the `close-row` request, which in 2.0 is DDR4 and DDR5 only; HBM2 and HBM3 abort with
  it, GDDR6 is not accepted by the `GenericDRAM` system, LPDDR5 fails a bank-state check under the Generic
  controller, and DDR5 needs an extra RFM parameter group. DDR4 is the one type where every knob works unpatched.
- Workload: synthetic, `gen-trace.mjs` in this directory, deterministic from the seed (mulberry32).
- Evaluator image: `Dockerfile` in this directory, an unverified draft (Docker was not available on the machine
  that wrote it).
