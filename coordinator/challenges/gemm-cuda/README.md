# gemm-cuda: a 4096 x 4096 fp32 GEMM in CUDA, timed on the participant's own NVIDIA GPU

**Level:** L2. **Kind:** timing. **Objective:** `medianMs`, lower is better.
**Hardware class:** `nvidia-geforce-rtx-4090`. **Toolkit:** CUDA 12.6, `-arch=sm_89`.
**Agreement band:** 10 percent. **Time budget:** 180 s. **On when** `DMI_ENABLE_GPU=1`.

## Read this first: what has never been run

This challenge was written on an Apple M5 Pro. Metal, no NVIDIA GPU, no CUDA toolkit, no `nvcc`, no
`nvidia-smi`. So the honest split is:

**Verified on that machine, by `test/gpu.test.mjs`:**

- the submission rules, on the reference kernel and on the example: entry point, size, include allowlist,
  banned tokens, `#pragma unroll` allowed, inline PTX allowed, `#pragma omp` refused
- the input files, the hidden seed rewriting the hidden file and leaving it alone when nothing changed
- the registry entry: it describes itself, pins the card, pins the toolkit, and its constraints carry the
  numbers a participant needs
- the routing: a node reports this challenge only with hardware class `nvidia-geforce-rtx-4090` and `nvcc`
  at release 12.6, and a `cpu-generic` or H100 node never does
- the parsing of `nvcc --version`, against the documented text, so the release lands where the version pin
  can read it
- the agreement band and the settled value on this challenge's `tolerancePct`
- that the harness **stops** here rather than degrading: with no `nvcc`, `simulate()` throws
  `gemm-cuda is compiled with nvcc (CUDA toolkit 12.6) and it was not found on PATH; set DMI_NVCC_BIN`

**Not verified, and not claimed:**

- `run.cu` and `baseline.cu` have never been compiled. `nvcc` has never seen them.
- `examples/gemm-cuda-tiled.cu` has never been compiled and its speed has never been measured.
- The `Dockerfile` has never been built. The base tag, the toolkit version and the smoke check in it are
  claims to check on the first GPU host.
- The exact string `nvidia-smi --query-gpu=name` prints for a 4090 has not been read off a card. It is
  believed to be `NVIDIA GeForce RTX 4090`, which normalizes to the class above. A node whose card prints
  something else sets `DMI_HARDWARE`; the value to correct is `HARDWARE_CLASS` in `harness.js`.
- The exact text of `nvcc --version` has not been read off a toolkit. The test checks the parser against
  the documented format using a stub script, which is a test of the parser, not of nvcc.
- The tolerance band and the agreement band are derived, not measured. See both sections below.

Every one of those is a first-run item on a real 4090, and the harness fails loudly for each: a missing
compiler throws by name before anything is compiled, and `run.cu` exits non-zero with
`no CUDA device is visible to this process` when there is no card.

## Why a GEMM

A GEMM is the honest first GPU challenge, for the same reasons `matmul-cpu` was the honest first timing
challenge.

- **It is verifiable.** One reference kernel, one output matrix, element by element against a published
  tolerance. There is no scoring judgment to argue with, and a wrong kernel is invalid before a clock starts.
- **Every optimisation is visible in the number.** Shared-memory tiling, register tiling, vectorized loads,
  double buffering, bank conflicts, tensor cores. Each one changes the arithmetic intensity or the memory
  traffic by a factor you can work out on paper, so the objective has a long way to travel and small
  improvements are still readable above the band. How far, on this card, is one of the numbers the first real
  run produces; none of it has been measured here.
- **It has a known ceiling**, which is what makes the frontier meaningful: a participant can compare against
  what the hardware can do rather than only against the last submission.
- **The shape is already proven in DMI.** `matmul-cpu` runs the whole timing path on a laptop: static rules,
  correctness gate, median of repeated passes, two-node agreement inside a band, ledger. This challenge is the
  same shape with the compiler, the hardware class and the tolerance changed, so what is new here is the GPU
  part and nothing else.

Fused attention and a fused MoE gate are harder and more interesting, and both are worse as the first one:
their references are longer, their tolerances are arguable, and a bug in the driver is hard to tell apart from
a bug in the kernel. Build them after a real 4090 has run this one end to end.

## What the challenge is

The submission is one CUDA file that defines

```cpp
extern "C" void dmi_sgemm(const float* A, const float* B, float* C, int n);
```

`A`, `B` and `C` are **device** pointers, row major. `C` is zeroed on the device before every call.
`C = A * B`. The launch goes on the default stream; the driver synchronizes after it, so the kernel does not
have to. The kernel may not allocate, free or copy device memory: the driver owns every byte, so no work can
be moved out of the timed window.

## Objective

`run.cu` generates two pairs of 4096 x 4096 float matrices on the host from the seed (mulberry32, the same
generator every DMI trace uses), copies them to the device once, calls the kernel once to warm up, then seven
times. Each pass is timed with `steady_clock` around the launch plus `cudaDeviceSynchronize`. The zeroing of
`C` and the synchronize that follows it are outside the timed window, so the number is the kernel.
`medianMs` is the median of the seven passes over both cases.

Before any of that, one pass is checked against the reference kernel (`baseline.cu`, compiled with the same
driver and run in a separate process on the same inputs). A miss is rejected before timing. The outputs of the
timed pass are compared again, so a kernel that stops doing the work once it is being timed is caught.

## Correctness, and what the tolerance decides

Every output element must satisfy `|got - ref| <= 1e-2 + 2e-3 * |ref|`. Every element, no exceptions.

Where that comes from: a sum of 4096 products of values in `[-1, 1)` lands around magnitude 20, and
reordering an fp32 sum of that length moves the result by roughly `n * eps * partial`, about `1e-2`. So the
band passes any honest reordering of the same fp32 work (a tiled kernel, a split-k kernel, a different
accumulation tree) and rejects a kernel that skips elements or corrupts them.

That band is also the whole rule on reduced precision. Nothing in the source is checked for `wmma` or
`mma.sync`, because inline PTX makes that unenforceable and inline PTX is where the fastest honest kernels
live. A tensor-core path counts if and only if its outputs pass this band on the hidden inputs. tf32 sits
close to the line, which is the intended answer: it qualifies when it is accurate enough, and it does not when
it is not.

**This band is arithmetic, not an observation.** No kernel has been run against it. It is the first thing to
re-check on a real card: if honest tiled kernels miss it, the band is wrong, not the kernels.

## Why the hardware class is part of the challenge

A 4090 number and an H100 number are not comparable, so they are not compared. The registry entry pins
`hardwareClass: 'nvidia-geforce-rtx-4090'`, and `coordinator/compute.js` only offers a timing job to a node
whose reported class is that string (`canRun`). `probeHardware()` in `cli/compute.js` builds the class from
`nvidia-smi --query-gpu=name`, so a participant who runs `dmi compute` on their own 4090 is routed this job
and a participant on an H100 is not. `DMI_HARDWARE` overrides the probe.

Another card is another challenge: a new registry entry, its own class, its own `-arch`, its own frontier.

## Why the toolkit version is pinned

`toolVersions: { nvcc: '12.6' }`, for the same reason `rtl-synth-fifo` pins Yosys 0.52. The score is the
compiler's output. nvcc's instruction scheduling, its unrolling and its register allocation move between
releases, so the same source is a different number on a different toolkit, and two honest nodes would be
recorded as disagreeing over nothing. A node reports this challenge only when `nvcc --version` prints release
12.6. The image in this directory is where that release comes from.

Rank ideas locally on whatever toolkit you have. The number the network returns is the one that counts.

## Rules

Checked by `loadPolicySource()` before `nvcc` is even resolved, each with a message that names the rule:

- under 64 KB, defines the entry point above
- includes only from: `cuda_runtime.h`, `cuda_runtime_api.h`, `cuda_fp16.h`, `cuda_bf16.h`, `mma.h`,
  `cooperative_groups.h`, `cuda/pipeline`, `cuda/barrier`, `cstddef`, `cstdint`, `cmath`, `cstring`,
  `algorithm` and their C spellings. `cublas_v2.h`, `cublasLt.h`, `cudnn.h` and cutlass headers are not on
  the list, and the fixed flags link no library, so a vendor GEMM does not build. The challenge is the kernel,
  not the call.
- no device memory management: `cudaMalloc`, `cudaMemcpy`, `cudaFree` and the rest of that family
- no host escapes: `system`, `popen`, `exec`, `fork`, `dlopen`, sockets, `mmap`, `signal`, `exit`, `getenv`,
  no `main`, no `__attribute__`
- no OpenMP and no host threads. `#pragma` **is** allowed, because `#pragma unroll` is one of the things being
  measured; `#pragma omp` is still refused, by the `omp` token.
- inline `asm` **is** allowed, unlike `matmul-cpu`. `mma.sync` and `ldmatrix` are reached through PTX. The
  container the evaluator runs in is the boundary; these rules are a courtesy that gives a clear message
  before the compiler does.

Compiled with `nvcc -O3 -std=c++17 -arch=sm_89 run.cu kernel.cu`. Compile, the reference run, the correctness
run and the seven timed passes must finish inside 180,000 ms. A template-heavy kernel can spend a minute of
that in nvcc alone.

## The agreement band

Timing is not deterministic, so two scorers agree when their medians are within 10 percent, the settled value
is the median of the agreeing medians, and a submission promotes only when it beats the frontier by more than
the band. See `resultsAgree` and `settledResult` in `coordinator/compute.js` and `beatsBar` in
`coordinator/server.js`.

Ten percent is the same band `matmul-cpu` settled on, for a wider reason. Two nodes in this class are two
different physical 4090s: different board partners, different power limits, different cooling, different host
CPUs, and a card at its power limit clocks down mid-run. The cross-node spread is what the band has to cover.

**Starting value, not a measurement.** No two 4090 nodes have reported on it. Tighten it when they have.
`DMI_TIMING_TOLERANCE_PCT` widens it on a machine known to be busy, such as CI.

## Running it

On a GPU node with the pinned toolkit:

```
node coordinator/challenges/gemm-cuda/harness.js examples/gemm-cuda-tiled.cu
node coordinator/challenges/gemm-cuda/harness.js coordinator/challenges/gemm-cuda/baseline.cu
DMI_ENABLE_GPU=1 node --test test/gpu.test.mjs
```

On a machine with no NVIDIA GPU the same test file runs the rules, the registry, the routing and the version
pin, and skips the three tests that need a card with the reason printed. The harness itself refuses to run
with a message naming `nvcc` and `DMI_NVCC_BIN`.

## Provenance

- Driver `run.cu`, reference `baseline.cu`, inputs `public-inputs.json`
  (`{"seed":1,"n":4096,"cases":2}`), all in this directory. The hidden inputs are the same shape with the
  coordinator's hidden seed, written by `ensureTraces()`.
- Generic contest harness: `coordinator/challenges/_contest/harness.js`.
- Example kernel: `examples/gemm-cuda-tiled.cu`, unbuilt.
- Toolkit: CUDA 12.6 from the `Dockerfile` in this directory, unbuilt.
