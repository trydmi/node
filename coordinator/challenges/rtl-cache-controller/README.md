# rtl-cache-controller: a cache replacement and prefetch policy in Verilog, scored in Verilator

**Level:** L3 (RTL simulation, evaluator tier E1). **Objective:** `cycles`, lower is better.
**Time budget:** 150 s per trace, compile plus simulation. **Status:** first L3 challenge, measured on 2026-09-07.

## What the challenge is

A small in-order core runs the inner loop of an inference kernel. Its 16 KB data cache sees four kinds of
traffic: a hot working set that almost fits, long sequential weight streams that are read once, cyclic scans
of buffers larger than the cache, and pointer chases over a fixed random order. The phases interleave. Every
miss stalls the core for 40 cycles or more.

The cache's replacement and prefetch policy decides which line each fill overwrites and whether to fetch a
line before the core asks for it. That policy is the submission: one synthesizable Verilog module. A C++
testbench compiled with Verilator replays the trace cycle by cycle against the module and counts total cycles.

The cache and the memory behind it are fixed: 64 sets, 4 ways, 64-byte lines (16 KB), 32-bit addresses,
write-allocate, write-back. Memory latency is 40 cycles from issue. The channel issues one fill every 4
cycles and holds at most 4 fills in flight. Demand fills, prefetch fills and dirty write-backs share it.

## Objective

`cycles` is accesses plus stall cycles:

- a hit costs 1 cycle
- a demand miss stalls the core until its fill returns: the wait for a channel slot plus the 40-cycle latency
- a demand miss on a line whose prefetch is already in flight waits only for the remaining latency
- a prefetch never stalls the core; it takes a fill slot and channel time until it returns, then the policy
  picks the way it lands in
- a prefetch for a line that is resident or in flight is dropped at no cost
- evicting a dirty line takes one channel slot, with no core stall

The objective is an integer, deterministic (Verilator has no randomness with the flags the harness passes, and
the testbench has none) and reproduced by a second run before a score counts. The harness also reports
`stalls`, `hitRate`, `prefetches`, `prefetchHits`, `prefetchDropped` and `writebacks` as diagnostics.

## The workload

`gen-trace.mjs` writes one access per line, `R <hex>` or `W <hex>`, byte addresses. Phases are drawn at random
until the trace has 1,000,000 accesses:

| Phase | What it does | What wins |
| --- | --- | --- |
| hot | 2,000 to 8,000 accesses to a 176-line (11 KB) working set, skewed toward a few lines, 15 percent stores | keeping it resident |
| stream | one sequential read of 256 to 2,048 lines, every 8-byte word of every line | prefetch; not letting it evict the hot set |
| mix | the hot loop keeps running (60 percent of accesses) while a stream is read through it | both of the above at once |
| scan | 3 passes in address order over 384 to 768 lines (24 KB to 48 KB, larger than the cache) | prefetch, or keeping part of the buffer |
| chase | 2 passes over 512 lines (32 KB) in a fixed random order | keeping part of the buffer; prefetch does not help |

The public trace is seed 1: 1,000,000 accesses (919,574 reads, 80,426 writes), 11 MB on disk. It is not
committed; `node gen-trace.mjs --seed 1` recreates it byte for byte in about 100 ms. The hidden trace is another
seed with different region bases, stream lengths, scan sizes, chase order and phase order. The model shape is
the same.

## What a submission is

One Verilog file, under 64 KB, that defines exactly one module named `dmi_cache_policy` with this port list.
Helper modules are allowed.

```verilog
module dmi_cache_policy (
  input  wire        clk,
  input  wire        rst_n,            // active low, held low for two clocks at the start
  input  wire        access_valid,     // one policy event this clock
  input  wire [31:0] access_addr,      // byte address of the access, or of the line being installed
  input  wire [5:0]  access_set,       // access_addr[11:6]
  input  wire        access_hit,       // 1: demand hit in access_way. 0: a line is being installed at victim_way
  input  wire [1:0]  access_way,       // the way that hit (only when access_hit)
  input  wire        access_write,     // the access is a store
  input  wire        access_prefetch,  // the install is a prefetch fill, not a demand fill
  output wire [1:0]  victim_way,       // way to overwrite when !access_hit; read before the clock edge
  output wire        prefetch_valid,   // request a prefetch of prefetch_addr
  output wire [31:0] prefetch_addr,    // any byte address; the testbench uses its line
  input  wire        prefetch_ready    // a fill slot and the channel are free; the request is taken on this edge
);
```

Three kinds of event reach the module, one clock each:

| Event | Inputs | What the testbench does with the outputs |
| --- | --- | --- |
| demand hit | `access_valid=1, access_hit=1, access_way=w` | nothing; the policy updates its state |
| demand fill | `access_valid=1, access_hit=0, access_prefetch=0` | overwrites `victim_way` in `access_set` with the missed line |
| prefetch fill | `access_valid=1, access_hit=0, access_prefetch=1` | overwrites `victim_way` in `access_set` with the prefetched line |

`victim_way` is combinational: the testbench sets the inputs, evaluates, reads `victim_way`, then clocks. It
uses the value as-is and never overrides it, so cold sets are the policy's problem too. After reset every set is
empty and the policy has seen every fill it ever chose, so it knows which ways hold what.

`prefetch_valid` and `prefetch_addr` are read on every event the same way. When `prefetch_ready` is high on
that event, the request is taken on the clock edge, and the policy should drop it. The testbench does not tell
the policy when a prefetch returns; the prefetch fill event is the signal. A policy that never prefetches ties
`prefetch_valid` low.

## Rules

Checked by `loadPolicySource()` before Verilator runs, each with a message that names the rule:

- one module named `dmi_cache_policy`, port names exactly as above; widths are Verilator's job (`WIDTH` is fatal)
- no system tasks except `$signed`, `$unsigned`, `$clog2`, `$bits`; so no `$system`, `$fopen`, `$display`,
  `$readmem`, `$c`
- no DPI, no `` `include ``, no directives outside `` `define `` `` `ifdef `` `` `ifndef `` `` `elsif `` `` `else ``
  `` `endif `` `` `undef `` `` `default_nettype ``
- no delays (`#`), no `initial` blocks other than constant assignments to registers, no `fork`, `wait`, `force`,
  `release`, `event`
- no `verilator` metacomments

Then Verilator's default warnings are fatal: a width mismatch, a combinational loop (`UNOPTFLAT`), a latch you
did not mean to infer. The first lines of the report come back in the verdict. Fix the design.

Compile plus simulation must finish inside 150,000 ms. The baseline compiles in about 1.2 s and simulates in
about 0.3 s on a laptop, so the budget is for large designs and slow containers.

Two runs of the same source must return the same `cycles` and the same `fingerprint` (a hash of every
statistic plus a hash of every decision the policy made). Identical fingerprints mean identical policies, and
a policy that behaves exactly like the baseline earns no credit.

## Measured numbers (Apple silicon laptop, Verilator 5.052, 2026-09-07)

| Design | Trace | cycles | stalls | hitRate | prefetches | compile | sim |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline (`baseline.v`, true LRU) | public, seed 1 | 4,906,505 | 3,906,505 | 0.9025 | 0 | 1.1 s | 0.3 s |
| baseline, second run | public, seed 1 | 4,906,505 (same fingerprint) | 3,906,505 | 0.9025 | 0 | 1.1 s | 0.3 s |
| `examples/rtl-lru-nextline.v` | public, seed 1 | 4,382,961 (10.67 percent better) | 3,382,961 | 0.9099 | 58,454 | 1.1 s | 0.3 s |
| baseline | hidden | 5,426,251 | 4,426,251 | 0.8895 | 0 | 1.1 s | 0.2 s |
| `examples/rtl-lru-nextline.v` | hidden | 4,791,664 (11.69 percent better) | 3,791,664 | 0.8995 | 64,523 | 1.1 s | 0.2 s |

The example is the baseline's LRU plus one pending next-line prefetch on every demand miss. Of its 58,454
prefetches on the public trace, 25,078 were hit while in flight and 6,563 were dropped as already resident. It
prefetches on hot-set and chase misses too, where the next line is rarely wanted, so the frontier starts with a
stream detector, a prefetch degree above one, and an insertion position for prefetch fills that does not push
hot lines out.

## Running it locally

```
node coordinator/challenges/rtl-cache-controller/gen-trace.mjs --seed 1
node coordinator/challenges/rtl-cache-controller/harness.js examples/rtl-lru-nextline.v
node --test test/rtl.test.mjs      # skips the Verilator tests when verilator is not on PATH
```

The harness writes `policy.v` and `tb.cpp` to a temp directory, runs
`verilator --cc --exe --build -j 2 --x-initial 0 --x-assign 0 -O3 --top-module dmi_cache_policy --Mdir obj -o sim tb.cpp policy.v`,
runs `obj/sim <trace>`, parses the JSON line it prints, and deletes the temp directory. Set `DMI_VERILATOR_BIN`
when `verilator` is not on PATH.

## Provenance

- Simulator: Verilator 5, https://github.com/verilator/verilator LGPL-3.0 or Artistic-2.0. Measured with
  5.052 (Homebrew, 2026-09-05 build). Production scores on Debian bookworm's 5.006, which has every flag the harness passes
  but rejects some constructs 5.052 accepts (seen 2026-09-08: a delayed assignment to a large array inside a for loop). Write to 5.006.
- Every Verilator flag in the harness was checked by running it: `--cc --exe --build` produce and build the
  executable in one call, `-j 2` bounds the build, `--x-initial 0 --x-assign 0` make every X a zero so two runs
  cannot differ, `-O3` is Verilator's optimization level, `--Mdir` and `-o` place the output. Default warnings
  are fatal without `-Wno-fatal`, which the harness does not pass. Without `-Wall`, unused inputs do not warn,
  so a policy may ignore ports it does not need.
- Testbench: `tb.cpp` in this directory. Trace: `gen-trace.mjs`, deterministic from the seed (mulberry32).
- Evaluator image: `Dockerfile` in this directory, an unverified draft (Docker was not available on the machine
  that wrote it).
