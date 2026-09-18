# matmul-cpu: a 512 x 512 float matmul in C++, timed on a laptop CPU

**Level:** L1. **Kind:** timing. **Objective:** `medianMs`, lower is better. **Hardware class:** `cpu-generic`.
**Agreement band:** 10 percent. **Time budget:** 60 s. **On when** `DMI_ENABLE_CONTEST=1`.

## What the challenge is

The smallest possible timing challenge. It exists so the whole timing path, from the static rules through the
compute-node agreement band to the ledger, can be run on a laptop with no GPU. It has the shape every kernel
challenge has: a fixed kernel signature, a driver the challenge provides, a reference implementation, hidden
inputs, a correctness gate, and a median wall time.

The submission is one C++ file that defines

```cpp
extern "C" void dmi_matmul(const float* A, const float* B, float* C, int n);
```

Row major, `C` is zeroed before every call, `C = A * B`, single thread.

## Objective

The driver (`run.cpp`) generates two pairs of 512 x 512 matrices from the seed (mulberry32, values in [-1, 1)),
calls the kernel once to warm up, then five times, timing each pass over both cases with `steady_clock`. `medianMs`
is the median of the five passes. Before that, one call per case is checked against the reference kernel
(`baseline.cpp`, compiled with the same driver in a separate process): every element must be within
`1e-3 + 1e-3 * |ref|`. A miss is rejected before timing. The outputs of the timed pass are checked too.

Timing is not deterministic, so two scorers agree when their medians are within 10 percent on `cpu-generic`, the
settled value is the median of the agreeing medians, and a submission promotes only when it beats the frontier by
more than 10 percent. See `coordinator/compute.js` (`resultsAgree`, `settledResult`) and `beatsBar` in
`coordinator/server.js`.

## Rules

Checked by `loadPolicySource()` before compiling, each with a message that names the rule:

- under 64 KB, defines the entry point above
- includes only from: `cstddef`, `cstdint`, `cmath`, `cstring`, `algorithm`, `immintrin.h`, `arm_neon.h`,
  `x86intrin.h` and their C spellings
- no `asm`, no threads or OpenMP, no `system`, `fopen`, `exec`, `fork`, `dlopen`, `mmap`, `signal`, `exit`,
  `getenv`, no `main`, no `__attribute__`, no `#pragma`

Compiled with `c++ -O2 -std=c++17 run.cpp kernel.cpp`. Compile plus the reference run, the correctness run and the
five timed passes must finish inside 60,000 ms.

## Measured numbers (Apple silicon laptop, Apple clang 17, 2026-09-08)

| Kernel | Inputs | medianMs | matchRatio | compile |
| --- | --- | --- | --- | --- |
| baseline (`baseline.cpp`, naive i-j-k) | public, seed 1 | 175.2 | 1 | 0.5 s |
| `examples/matmul-blocked.cpp` (i-k-j, blocked) | public, seed 1 | 12.4 | 1 | 0.5 s |
| baseline | hidden, seed 13 | about 172 | 1 | |
| `examples/matmul-blocked.cpp` | hidden, seed 13 | about 12.4 | 1 | |

The example is 14x faster. Run to run, medians on this laptop move by 1 to 5 percent, which is why the band is 10.

## Running it locally

```
node coordinator/challenges/matmul-cpu/harness.js examples/matmul-blocked.cpp
node coordinator/challenges/matmul-cpu/harness.js coordinator/challenges/matmul-cpu/baseline.cpp
DMI_ENABLE_CONTEST=1 node --test test/contest.test.mjs
```

## Provenance

- Driver `run.cpp`, reference `baseline.cpp`, inputs `public-inputs.json` (`{"seed":1,"n":512,"cases":2}`), all in
  this directory. The hidden inputs are the same shape with the coordinator's hidden seed, written by `ensureTraces()`.
- Generic harness: `coordinator/challenges/_contest/harness.js`.
