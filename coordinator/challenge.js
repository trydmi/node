/**
 * Challenge registry. Adding a challenge is a directory under coordinator/challenges plus an entry here.
 * Each challenge owns its harness, baseline, public trace and hidden trace. The evaluator loads the harness by path.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateTrace, DEFAULT_PARAMS } from './challenges/kv-cache-eviction/gen-trace.js'
import { DATA_DIR } from './paths.js'
import { ensureDramTraces, DEFAULT_PARAMS as DRAM_PARAMS } from './challenges/dram-controller/gen-trace.mjs'
import { HARDWARE as DRAM_HARDWARE } from './challenges/dram-controller/harness.js'
import { ensureRtlTraces, DEFAULT_PARAMS as RTL_PARAMS } from './challenges/rtl-cache-controller/gen-trace.mjs'
import { HARDWARE as RTL_HARDWARE, PORTS as RTL_PORTS } from './challenges/rtl-cache-controller/harness.js'
import { ensureSynthTraces, DEFAULT_PARAMS as SYNTH_PARAMS } from './challenges/rtl-synth-fifo/gen-trace.mjs'
import { HARDWARE as SYNTH_HARDWARE, PORTS as SYNTH_PORTS, LIBERTY as SYNTH_LIBERTY } from './challenges/rtl-synth-fifo/harness.js'
import { ensureMatmulInputs, HARDWARE_CLASS as MATMUL_HARDWARE, REPEATS as MATMUL_REPEATS, TOLERANCE_PCT as MATMUL_TOLERANCE, SHAPE as MATMUL_SHAPE, ENTRY as MATMUL_ENTRY } from './challenges/matmul-cpu/harness.js'
import { ensureGemmInputs, HARDWARE_CLASS as GEMM_HARDWARE, GPU_ARCH, CUDA_RELEASE, REPEATS as GEMM_REPEATS, TOLERANCE_PCT as GEMM_TOLERANCE, SHAPE as GEMM_SHAPE, ENTRY as GEMM_ENTRY, TOLERANCE as GEMM_TOLERANCE_BAND, NVCC_FLAGS, ALLOWED_INCLUDES as GEMM_INCLUDES } from './challenges/gemm-cuda/harness.js'

import { ensureProblems as ensureLeanProblems, DEFAULT_PARAMS as LEAN_PARAMS } from './challenges/lean-proofs/gen-problems.mjs'
import { HARDWARE as LEAN_HARDWARE, TACTIC as LEAN_TACTIC, ALLOWED_AXIOMS as LEAN_AXIOMS, TOOL_VERSION as LEAN_VERSION } from './challenges/lean-proofs/harness.js'
import { ensureSatInstances, DEFAULT_PARAMS as SAT_PARAMS } from './challenges/sat-branching/gen-instances.mjs'
import { SOLVER as SAT_SOLVER, MAX_CONFLICTS_PER_INSTANCE as SAT_MAX_CONFLICTS, MAX_PROPAGATIONS_PER_INSTANCE as SAT_MAX_PROPAGATIONS } from './challenges/sat-branching/harness.js'
import { ensureCompressionCorpora, DEFAULT_PARAMS as COMPRESS_PARAMS } from './challenges/compression-corpus/gen-corpus.mjs'
import { MAX_SOURCE_BYTES as COMPRESS_MAX_SOURCE } from './challenges/compression-corpus/harness.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = (id) => path.join(here, 'challenges', id)

export const CHALLENGES = {
  'kv-cache-real': {
    id: 'kv-cache-real',
    title: 'KV-cache eviction on real inference traffic',
    level: 'L1',
    tier: 'main',
    objective: 'bytesPerToken',
    direction: 'lower',
    summary:
      'A serving engine keeps prompt KV blocks (16 tokens, content addressed) at fixed capacity while real requests from a production ' +
      'LLM service arrive in their real order: real bursts, real prompt lengths, real multi-turn returns. A block that is not resident ' +
      'is loaded. Minimize bytes loaded per token. LRU is the baseline. The policy never sees output lengths, turn numbers or whether ' +
      'a conversation will return. Scored on a hidden time window from the same service.',
    constraints: [
      'Artifact is one CommonJS module. module.exports = function createPolicy({ capacity, blockBytes }) returning { onRequest?, onAccess, onEvict?, victim }.',
      'victim(req) must return a key that is currently resident. The harness does not hand over the resident set; keep your own bookkeeping.',
      'Must be O(1) or amortized O(1) per access. The public window is about 1 million accesses and must score within 10000 ms.',
      'No require, no I/O, no timers. The VM has none.',
      'Public window is minutes 0 to 30 of the trace. The hidden window is a later 30 minutes with re-permuted ids.',
    ],
    params: { capacity: 40000, blockBytes: 2 * 1024 * 1024, blockTokens: 16 },
    timeBudgetMs: 10000,
    provenance: 'Qwen Bailian usage traces (Alibaba, Apache-2.0), qwen_traceA_blksz_16.jsonl, sha256 07cedc9ed8aff301994ac68ed4aede8123b7603673575eeba9dd677de663db17',
    publicTrace: path.join(dir('kv-cache-real'), 'public-trace.json.gz'),
    hiddenTrace: path.join(DATA_DIR, 'kv-cache-real-hidden-trace.json.gz'),
    artifact: { file: 'policy.js', what: 'a CommonJS module' },
    unit: 'bytes per token',
    correctnessProof: 'every victim was resident',
    shortTitle: 'KV cache, real traffic',
    harness: path.join(dir('kv-cache-real'), 'harness.js'),
    baseline: path.join(dir('kv-cache-real'), 'baseline.js'),
    directions: ['returning conversations', 'shared system prefixes', 'burst admission', 'depth within prompt', 'idle-time decay'],
  },
  ...(process.env.DMI_ENABLE_DRAM === '1' ? {
  'dram-controller': {
      id: 'dram-controller',
      title: 'DRAM controller policy for LLM decode, scored in Ramulator 2.0',
      level: 'L2',
      tier: 'main',
      objective: 'cycles',
      direction: 'lower',
      summary:
        'A memory-bound accelerator runs LLM decode: every step streams all weights and re-reads the paged KV cache of ' +
        'eight active sequences, with four attention engines interleaving their page reads into the weight stream. The ' +
        'trace is replayed cycle by cycle in Ramulator 2.0 on DDR4-3200AA, 4 channels, 2 ranks. The submission is a ' +
        'JSON document that sets the controller policy: row policy (open, or closed with a column-access cap), address ' +
        'mapping (RoBaRaCoCh, ChRaBaRoCo, MOP4CLXOR) and write-drain watermarks. Minimize memory_system_cycles, the ' +
        'DRAM cycles until the last request is accepted. The baseline is the controller block of Ramulator\'s shipped ' +
        'example config. Scored on a hidden seed with different context lengths, page placement and region offsets.',
      constraints: [
        'Artifact is one JSON document (// comments allowed), not code. Keys: scheduler, refresh, row_policy, addr_mapper, wr_low_watermark, wr_high_watermark. Missing keys take the baseline value.',
        'scheduler must be "FRFCFS" and refresh must be "AllBank": they are the only implementations Ramulator 2.0\'s Generic controller has. They are in the document so a future Ramulator can widen the list without changing the contract.',
        'row_policy is { "impl": "OpenRowPolicy" } or { "impl": "ClosedRowPolicy", "cap": 1..4096 }. addr_mapper is one of RoBaRaCoCh, ChRaBaRoCo, MOP4CLXOR. Watermarks are numbers in [0, 1] with low below high.',
        'Any other key or value is rejected before Ramulator runs. The hardware (DDR4_8Gb_x8, 4 channels, 2 ranks, DDR4_3200AA, 64-byte transactions) is fixed.',
        'The public trace is seed 1 (about 2.9 million requests). Each run must finish within 120000 ms; the baseline takes about 20 s on a laptop, and a bad address mapping can take three times longer.',
      ],
      params: { hardware: DRAM_HARDWARE, workload: DRAM_PARAMS },
      timeBudgetMs: 120000,
      publicSeed: 1,
      provenance:
        'Synthetic decode trace from coordinator/challenges/dram-controller/gen-trace.mjs. Simulator: Ramulator 2.0 ' +
        '(CMU-SAFARI/ramulator2, MIT), commit 5e58d25f1a6efbbe6a4dceb42025d4af43fc75c6, 2026-01-06, built from source.',
      publicTrace: path.join(dir('dram-controller'), 'public-trace.trace'),
      hiddenTrace: path.join(DATA_DIR, 'dram-controller-hidden-trace.trace'),
      artifact: { file: 'policy.json', what: 'a JSON document' },
      unit: 'cycles',
      shortTitle: 'DRAM controller',
      harness: path.join(dir('dram-controller'), 'harness.js'),
      baseline: path.join(dir('dram-controller'), 'baseline.js'),
      correctnessProof: 'every request was served and the command stream obeyed the DDR4 timing rules',
      worker: { allowChildProcess: true, scratch: true, killAfterMs: 135000 },
      tools: ['ramulator'],
      directions: ['row policy versus stream length', 'channel interleave granularity', 'bank conflicts between KV pages and weight streams', 'write drain timing', 'closed-row cap tuning'],
    },} : {}),
  ...(process.env.DMI_ENABLE_RTL === '1' ? {
  'rtl-cache-controller': {
      id: 'rtl-cache-controller',
      title: 'Cache replacement and prefetch policy in Verilog, scored in Verilator',
      level: 'L3',
      tier: 'main',
      objective: 'cycles',
      direction: 'lower',
      summary:
        'A 16 KB, 4-way, 64-byte-line cache sits in front of an in-order core running an inference inner loop: a hot ' +
        'working set, long sequential weight streams, cyclic scans of buffers larger than the cache, and pointer chases ' +
        'over a fixed random order, interleaved. The submission is a synthesizable Verilog module, dmi_cache_policy, ' +
        'that picks the way every fill overwrites and may request prefetches. A C++ testbench compiled with Verilator ' +
        'replays the trace cycle by cycle: a hit is 1 cycle, a demand miss stalls until its fill returns (latency 40, ' +
        'one fill issued per 4 cycles, 4 fill slots shared with prefetches). Minimize cycles, accesses plus stall ' +
        'cycles. The baseline is true LRU with no prefetch. Scored on a hidden seed with different region bases, ' +
        'stream lengths, scan sizes and phase order.',
      constraints: [
        'Artifact is one Verilog file, under 64 KB, defining exactly one module named dmi_cache_policy with this port list: ' + RTL_PORTS.map(([d, n, w]) => `${d} ${n}[${w}]`).join(', ') + '. Helper modules are allowed.',
        'victim_way is read combinationally in the cycle of the fill, before the clock edge; the testbench uses it as-is and never overrides it. prefetch_valid and prefetch_addr are read the same way and taken on the clock edge when prefetch_ready is high.',
        'Synthesizable only: no delays, no initial blocks except constant register initialization, no fork, wait, force, release, DPI, $system, $fopen, $display, $readmem or $c. Only $signed, $unsigned, $clog2 and $bits are allowed. No `include and no verilator metacomments.',
        'Verilator default warnings are fatal (WIDTH, UNOPTFLAT and the rest); the message comes back in the verdict. Fix the design, do not disable the warning.',
        'The public trace is seed 1 (1,000,000 accesses). Compile plus simulation must finish within 150000 ms; the baseline compiles in about 2 s and simulates in under 1 s on a laptop.',
      ],
      params: { hardware: RTL_HARDWARE, workload: RTL_PARAMS },
      timeBudgetMs: 150000,
      publicSeed: 1,
      provenance:
        'Synthetic access trace from coordinator/challenges/rtl-cache-controller/gen-trace.mjs. Simulator: Verilator 5 ' +
        '(verilator/verilator, LGPL-3.0 or Artistic-2.0), testbench tb.cpp in the challenge directory. Production scores on Debian bookworm Verilator 5.006; Homebrew 5.052 accepts a few constructs 5.006 rejects, so test against 5.006 rules.',
      publicTrace: path.join(dir('rtl-cache-controller'), 'public-trace.trace'),
      hiddenTrace: path.join(DATA_DIR, 'rtl-cache-controller-hidden-trace.trace'),
      artifact: { file: 'policy.v', what: 'a Verilog file' },
      unit: 'cycles',
      shortTitle: 'Cache policy in Verilog',
      harness: path.join(dir('rtl-cache-controller'), 'harness.js'),
      baseline: path.join(dir('rtl-cache-controller'), 'baseline.v'),
      correctnessProof: 'the policy module answered every cycle and every victim was resident',
      worker: { allowChildProcess: true, scratch: true, killAfterMs: 170000 },
      tools: ['verilator', 'cxx'],
      directions: ['stream detection and prefetch degree', 'prefetch fill insertion position', 'scan resistance', 'dead-line prediction after a stream', 'write-aware replacement'],
    },} : {}),
  ...(process.env.DMI_ENABLE_SYNTH === '1' ? {
  'rtl-synth-fifo': {
      id: 'rtl-synth-fifo',
      title: 'A FIFO with an in-line CRC-8 in Verilog, checked in Verilator, scored by area and timing after Yosys synthesis',
      level: 'L4',
      tier: 'main',
      objective: 'ppa',
      direction: 'lower',
      summary:
        'A 32-entry, 32-bit synchronous FIFO with show-ahead output, full, empty, almost-full (28 or more) and almost-empty ' +
        '(4 or fewer) flags, a 6-bit count, and a running CRC-8 (polynomial 0x07, init 0) over every accepted pushed word. ' +
        'The submission is a synthesizable Verilog module, dmi_fifo_crc, with a fixed port list. A C++ testbench compiled ' +
        'with Verilator drives a seeded push and pop sequence with backpressure and compares every output, every cycle, ' +
        'against a golden model; one disagreement and the design scores nothing. A design that passes is synthesized in ' +
        'Yosys against the SkyWater sky130_fd_sc_hd standard cell library (typical corner). Minimize ppa, the cell area in ' +
        'square microns times the longest combinational path in nanoseconds. The baseline is a plain FIFO with binary ' +
        'pointers, a count register, combinational flags and a bit-serial CRC. The hidden trace is another seed of the same stimulus.',
      constraints: [
        'Artifact is one Verilog file, under 64 KB, defining exactly one module named dmi_fifo_crc with this port list: ' + SYNTH_PORTS.map(([d, n, w]) => `${d} ${n}[${w}]`).join(', ') + '. Helper modules are allowed; the design is flattened before mapping.',
        'Behavior is fixed by the golden model in tb.cpp: do_push = push && !full and do_pop = pop && !empty, both from the state before the clock edge; dout is the head word whenever the FIFO is not empty; crc is over accepted pushes, most significant byte first, visible the cycle after the push; reset is rst_n low for two clocks. Outputs are sampled before the clock edge.',
        'Synthesizable only: no delays, no initial blocks except constant register initialization, no fork, wait, force, release, DPI, $system, $fopen, $display, $readmem or $c. Only $signed, $unsigned, $clog2 and $bits are allowed. No `include and no verilator metacomments.',
        'Verilator default warnings are fatal, and so is any Yosys warning (a latch, an undriven wire, an unmapped cell). The message comes back in the verdict. Fix the design, do not disable the warning.',
        'The library is ' + SYNTH_LIBERTY.name + ' (sha256 ' + SYNTH_LIBERTY.sha256 + ' of the .lib); low-power, probe, clock and delay cells are dont_use. Timing is abc\'s stime with inputs driven by buf_1 and 5 fF on every output. ppa = stat area times that delay in ns; two runs of the same source give the same number.',
        'The public trace is seed 1 (100,000 clocks). The whole run must finish within 300000 ms, of which synthesis gets at most 180000 ms; the baseline takes about 3 s end to end on a laptop.',
        'Scoring runs Yosys 0.52. Area and delay are that tool\'s own measurement, so another version gives another number for the same design. Rank the ideas locally on whatever version you have, and read the score the network returns as the number that counts.',
      ],
      params: { hardware: SYNTH_HARDWARE, workload: SYNTH_PARAMS, liberty: { name: SYNTH_LIBERTY.name, sha256: SYNTH_LIBERTY.sha256, dontUse: SYNTH_LIBERTY.dontUse, constr: SYNTH_LIBERTY.constr } },
      timeBudgetMs: 300000,
      publicSeed: 1,
      provenance:
        'Synthetic push and pop stimulus from coordinator/challenges/rtl-synth-fifo/gen-trace.mjs. Functional check: Verilator 5 ' +
        '(verilator/verilator, LGPL-3.0 or Artistic-2.0), testbench tb.cpp. Synthesis: Yosys (YosysHQ/yosys, ISC) with abc, measured on 0.68; ' +
        'production pins the OSS CAD Suite build named in the Dockerfile. Library: sky130_fd_sc_hd typical corner from the SkyWater open PDK ' +
        '(Apache-2.0), vendored as a gzip in the challenge directory; see REGISTRY.md.',
      publicTrace: path.join(dir('rtl-synth-fifo'), 'public-trace.trace'),
      hiddenTrace: path.join(DATA_DIR, 'rtl-synth-fifo-hidden-trace.trace'),
      artifact: { file: 'design.v', what: 'a Verilog file' },
      unit: 'um2 x ns',
      shortTitle: 'FIFO with CRC, synthesized',
      harness: path.join(dir('rtl-synth-fifo'), 'harness.js'),
      baseline: path.join(dir('rtl-synth-fifo'), 'baseline.v'),
      correctnessProof: 'every output matched the golden model on every cycle, and synthesis mapped the design with no latch and no unmapped cell',
      worker: { allowChildProcess: true, scratch: true, killAfterMs: 330000 },
      tools: ['yosys', 'verilator', 'cxx'],
      // Area and delay come out of abc, and two Yosys versions give two different numbers for the same design.
      // A node reports this challenge only when its `yosys -V` is this version, so every score in the network is
      // comparable. The evaluator image (Dockerfile in the challenge directory) is where the number comes from.
      toolVersions: { yosys: '0.52' },
      directions: ['registered flags and pointer comparisons', 'parallel CRC over the whole word', 'storage structure and read mux', 'one-hot or gray pointers', 'sharing the count with the pointers'],
    },} : {}),
  ...(process.env.DMI_ENABLE_CONTEST === '1' ? {
  'matmul-cpu': {
      id: 'matmul-cpu',
      title: '512 x 512 float matmul in C++, timed on a laptop CPU (contest mirror example)',
      level: 'L1',
      tier: 'main',
      kind: 'timing',
      objective: 'medianMs',
      direction: 'lower',
      hardwareClass: MATMUL_HARDWARE,
      repeats: MATMUL_REPEATS,
      tolerancePct: MATMUL_TOLERANCE,
      summary:
        'The smallest possible contest mirror (docs/internal/CONTEST_MIRROR.md), runnable on any machine with a C++ compiler. The ' +
        'submission is one C++ file that multiplies two 512 x 512 float matrices, single thread. Outputs must match the ' +
        'reference on hidden random inputs before any timing counts. Then the kernel runs 5 passes and the median wall ' +
        'time in milliseconds is the objective. The baseline is the naive triple loop. Two scorers agree when their medians ' +
        'are within 10 percent on the same hardware class (cpu-generic); an improvement must beat the frontier by more than that band.',
      constraints: [
        `Artifact is one C++ file under 64 KB that defines ${MATMUL_ENTRY}. Row major, C is zeroed before every call, C = A * B.`,
        'Single thread. Allowed includes: cstddef, cstdint, cmath, cstring, algorithm, immintrin.h, arm_neon.h. No asm, threads, OpenMP, I/O, main, or attributes; the source is rejected before compiling.',
        'Compiled with c++ -O2 -std=c++17 together with the contest driver run.cpp. Every output element must be within atol 1e-3 plus rtol 1e-3 of the reference (baseline.cpp) or the run is rejected before timing.',
        `Inputs are ${MATMUL_SHAPE.cases} pairs of ${MATMUL_SHAPE.n} x ${MATMUL_SHAPE.n} matrices generated from a seed (public seed 1; the hidden seed differs). Compile, reference run, correctness run and 5 timed passes must finish within 60000 ms.`,
        'Objective medianMs is the median of 5 timed passes over all inputs. Timing varies by machine, so scores are compared within a 10 percent band and only gains larger than the band promote.',
      ],
      params: { hardwareClass: MATMUL_HARDWARE, repeats: MATMUL_REPEATS, tolerancePct: MATMUL_TOLERANCE, shape: MATMUL_SHAPE, tolerance: { atol: 1e-3, rtol: 1e-3 }, cxxflags: ['-O2', '-std=c++17'] },
      timeBudgetMs: 60000,
      publicSeed: 1,
      provenance: 'Synthetic inputs (mulberry32 from the seed) generated inside coordinator/challenges/matmul-cpu/run.cpp. Reference: baseline.cpp in the same directory. Generic contest harness: coordinator/challenges/_contest/harness.js.',
      publicTrace: path.join(dir('matmul-cpu'), 'public-inputs.json'),
      hiddenTrace: path.join(DATA_DIR, 'matmul-cpu-hidden-inputs.json'),
      artifact: { file: 'kernel.cpp', what: 'a C++ file' },
      unit: 'ms',
      correctnessProof: 'every output element matched the reference within the published tolerance, on the timed pass too',
      shortTitle: 'Matmul kernel',
      harness: path.join(dir('matmul-cpu'), 'harness.js'),
      baseline: path.join(dir('matmul-cpu'), 'baseline.cpp'),
      worker: { allowChildProcess: true, scratch: true, killAfterMs: 90000 },
      tools: ['cxx'],
      directions: ['loop order', 'cache blocking', 'register tiling', 'SIMD intrinsics', 'packing B into a contiguous panel'],
    },} : {}),
  ...(process.env.DMI_ENABLE_LEAN === '1' ? {
  'lean-proofs': {
      id: 'lean-proofs',
      title: 'Automated theorem proving in Lean 4, scored on statements the tactic has never seen',
      shortTitle: 'Lean proof search',
      level: 'L2',
      tier: 'main',
      objective: 'unsolved',
      direction: 'lower',
      unit: 'goals left open',
      artifact: { file: 'tactic.lean', what: 'a Lean tactic' },
      summary:
        'You submit a tactic, not a proof. It is compiled against forty Lean statements it has never seen and scored ' +
        'on how many it leaves open. A lookup table of answers is worth nothing here, because the hidden set is ' +
        'different statements. A goal counts as closed only when Lean compiles it and the proof leans on nothing ' +
        'outside Lean\'s own three axioms, so sorry, a declared axiom and native_decide are all rejected. The baseline ' +
        'is what a beginner reaches for, rfl and simp, and it closes 3 of 40. The statements are arithmetic, list ' +
        'identities, modular arithmetic, bounds, and identities over recursive definitions that need a real induction.',
      constraints: [
        'Artifact is one Lean file, under 64 KB, that defines a tactic named ' + LEAN_TACTIC + '. It is applied to every goal, unchanged.',
        'A goal is closed only if Lean compiles it and #print axioms lists nothing outside ' + [...LEAN_AXIOMS].join(', ') + '. That rejects sorry, any axiom you declare, and native_decide.',
        'No sorry, no axiom, no native_decide, no @[implemented_by], no unsafe, no IO, no #eval, and no import outside core Lean.',
        'Core Lean ' + LEAN_VERSION + ', no mathlib. Everything in the hidden set is provable without it.',
        'The whole run has 300000 ms for all forty goals, and maxHeartbeats is 40000 per goal. The baseline finishes in under a second.',
      ],
      params: { toolchain: LEAN_HARDWARE, problems: LEAN_PARAMS.count, tactic: LEAN_TACTIC, allowedAxioms: [...LEAN_AXIOMS] },
      timeBudgetMs: 300000,
      publicSeed: 1,
      provenance:
        'Statements generated by coordinator/challenges/lean-proofs/gen-problems.mjs, deterministic from the seed. Every ' +
        'generated statement is checked provable before it ships (scripts/dev/verify-lean-problems.mjs). Prover: Lean 4 ' +
        '(leanprover/lean4, Apache-2.0), core only.',
      publicTrace: path.join(dir('lean-proofs'), 'public-problems.json'),
      hiddenTrace: path.join(DATA_DIR, 'lean-proofs-hidden-problems.json'),
      harness: path.join(dir('lean-proofs'), 'harness.js'),
      baseline: path.join(dir('lean-proofs'), 'baseline.lean'),
      correctnessProof: 'every goal it closed was compiled by Lean and depends on no axiom beyond Lean\'s own',
      worker: { allowChildProcess: true, scratch: true, killAfterMs: 330000 },
      tools: ['lean'],
      toolVersions: { lean: LEAN_VERSION },
      directions: ['chaining simp into omega', 'induction on the list argument', 'unfolding a recursive definition before simp', 'trying cheap tactics first so the budget lasts', 'simp_all with hypotheses'],
    },} : {}),
  ...(process.env.DMI_ENABLE_GPU === '1' ? {
  'gemm-cuda': {
      id: 'gemm-cuda',
      title: '4096 x 4096 fp32 GEMM in CUDA, timed on the participant\'s own NVIDIA GPU',
      level: 'L2',
      tier: 'main',
      kind: 'timing',
      objective: 'medianMs',
      direction: 'lower',
      hardwareClass: GEMM_HARDWARE,
      repeats: GEMM_REPEATS,
      tolerancePct: GEMM_TOLERANCE,
      summary:
        'The submission is one CUDA file that multiplies two 4096 x 4096 fp32 matrices on the GPU. The node running the job ' +
        'is the card being measured: a participant runs `dmi compute` on their own NVIDIA GPU and the coordinator only sends ' +
        'this job to nodes reporting the ' + GEMM_HARDWARE + ' class, because a 4090 number and an H100 number are not ' +
        'comparable. Outputs must match the reference kernel on hidden random inputs, inside the published tolerance, before ' +
        'any timing counts. Then the kernel runs ' + GEMM_REPEATS + ' passes and the median wall time in milliseconds is the ' +
        'objective. The baseline is one thread per output element reading straight from global memory. Two scorers agree when ' +
        'their medians are within ' + GEMM_TOLERANCE + ' percent on the same hardware class, and an improvement must beat the ' +
        'frontier by more than that band.',
      constraints: [
        `Artifact is one CUDA file under 64 KB that defines ${GEMM_ENTRY}. A, B and C are DEVICE pointers, row major. C is zeroed on the device before every call. C = A * B.`,
        'The launch goes on the default stream and the driver synchronizes after it. The kernel may not allocate, free or copy device memory: the driver owns A, B and C, so no work can hide outside the timed window. cudaMalloc, cudaMemcpy, cudaFree and the rest are rejected before compiling.',
        `Allowed includes: ${GEMM_INCLUDES.join(', ')}. cublas, cublasLt, cudnn and cutlass headers are not on the list and the flags link no library, so a vendor GEMM does not build. No host escapes (system, exec, fork, dlopen, sockets), no main, no OpenMP. Inline PTX asm IS allowed, because mma.sync and ldmatrix are reached that way.`,
        `Compiled with nvcc ${NVCC_FLAGS.join(' ')} together with the driver run.cu, on CUDA toolkit ${CUDA_RELEASE}. -arch=${GPU_ARCH} is the architecture of the ${GEMM_HARDWARE} class. A node scores this challenge only when its nvcc reports release ${CUDA_RELEASE}, because the same kernel is a different number on a different toolkit.`,
        `Every output element must be within atol ${GEMM_TOLERANCE_BAND.atol} plus rtol ${GEMM_TOLERANCE_BAND.rtol} of the reference (baseline.cu, run in a separate process on the same inputs) or the run is rejected before timing. Reduced-precision paths, tf32 tensor cores included, are decided by that band and by nothing else.`,
        `Inputs are ${GEMM_SHAPE.cases} pairs of ${GEMM_SHAPE.n} x ${GEMM_SHAPE.n} matrices generated from a seed on the host and copied to the device once (public seed 1; the hidden seed differs). Compile, reference run, correctness run and ${GEMM_REPEATS} timed passes must finish within 180000 ms; a template-heavy kernel can spend a minute of that in nvcc.`,
        `Objective medianMs is the median of ${GEMM_REPEATS} timed passes over all inputs. Timing varies between two cards of the same model, so scores are compared within a ${GEMM_TOLERANCE} percent band and only gains larger than the band promote.`,
      ],
      params: { hardwareClass: GEMM_HARDWARE, gpuArch: GPU_ARCH, cudaRelease: CUDA_RELEASE, repeats: GEMM_REPEATS, tolerancePct: GEMM_TOLERANCE, shape: GEMM_SHAPE, tolerance: { atol: GEMM_TOLERANCE_BAND.atol, rtol: GEMM_TOLERANCE_BAND.rtol }, nvccFlags: NVCC_FLAGS },
      timeBudgetMs: 180000,
      publicSeed: 1,
      provenance:
        'Synthetic inputs (mulberry32 from the seed) generated on the host inside coordinator/challenges/gemm-cuda/run.cu. ' +
        'Reference: baseline.cu in the same directory. Generic contest harness: coordinator/challenges/_contest/harness.js. ' +
        `Toolkit: CUDA ${CUDA_RELEASE} from the Dockerfile in the challenge directory. The driver, the reference and that image ` +
        'have not been compiled or run yet: they were written on a machine with no NVIDIA GPU. See the challenge README.',
      publicTrace: path.join(dir('gemm-cuda'), 'public-inputs.json'),
      hiddenTrace: path.join(DATA_DIR, 'gemm-cuda-hidden-inputs.json'),
      artifact: { file: 'kernel.cu', what: 'a CUDA file' },
      unit: 'ms',
      correctnessProof: 'every output element matched the reference kernel within the published tolerance, on the timed pass too, so a wrong kernel is invalid before anything is timed',
      shortTitle: 'GEMM kernel on your GPU',
      harness: path.join(dir('gemm-cuda'), 'harness.js'),
      baseline: path.join(dir('gemm-cuda'), 'baseline.cu'),
      worker: { allowChildProcess: true, scratch: true, killAfterMs: 210000 },
      tools: ['nvcc', 'cxx'],
      // nvcc's scheduling, unrolling and register allocation move between releases, so the same kernel is a
      // different number on a different toolkit. A node reports this challenge only when its nvcc is this release.
      toolVersions: { nvcc: CUDA_RELEASE },
      directions: ['shared-memory tiling', 'register tiling per thread', 'vectorized global loads', 'double buffering the shared tiles', 'bank-conflict-free shared layout', 'tensor cores through mma.h or PTX, if the outputs stay inside the tolerance'],
    },} : {}),
  ...(process.env.DMI_ENABLE_SAT === '1' ? {
  'sat-branching': {
      id: 'sat-branching',
      title: 'A branching and restart heuristic for a fixed CDCL SAT solver, scored in conflicts',
      level: 'L2',
      tier: 'main',
      objective: 'conflicts',
      direction: 'lower',
      summary:
        'One CDCL SAT solver, fixed for everybody: two watched literals, unit propagation, first-UIP learning ' +
        'with minimization, LBD, backjumping, a learned-clause reduction on a fixed schedule. The submission is ' +
        'the part that chooses: which literal to branch on at every decision, and optionally when to restart. ' +
        'The solver hands it every assignment, every unassignment, every variable conflict analysis touches, and ' +
        'every learned clause. Twenty four instances are generated from a seed: random 3-SAT at the threshold, ' +
        'random 3-SAT above it, pigeonhole, and 4-colouring of a random graph. Minimize conflicts, the total over ' +
        'the whole set. The baseline is plain VSIDS bumping the learned clause, always branching false. Scored on ' +
        'a hidden seed with the same four families and the same sizes.',
      constraints: [
        'Artifact is one CommonJS module. module.exports = function createHeuristic({ vars, clauses, name, family }) returning { decide, onAssign?, onUnassign?, onConflict?, onAnalyze?, onLearn?, restart? }.',
        'decide() must return a literal in [-vars, vars] without 0, and the variable must be unassigned. Return an assigned or out-of-range variable and the submission is invalid, not scored badly.',
        'A fresh heuristic is built for every instance. Nothing carries over: no cross-instance learning, and clauses is the only view of the formula.',
        'No require, no I/O, no timers, no clock. The VM has none. Defining restart() replaces the solver\'s Luby schedule; leaving it out keeps it.',
        `An instance must be decided inside ${SAT_MAX_CONFLICTS.toLocaleString('en-US')} conflicts and ${SAT_MAX_PROPAGATIONS.toLocaleString('en-US')} propagations. Both caps are deterministic, so a submission is invalid on every machine or on none.`,
        'Correctness first: a satisfiable answer is checked assignment against clauses before its conflicts count, and an unsatisfiable answer must match the recorded status. One wrong answer voids the whole submission.',
        'The public set is seed 1 (24 instances). The whole set must finish within 90000 ms; the baseline takes about 3 s on a laptop.',
      ],
      params: { solver: SAT_SOLVER, instances: SAT_PARAMS, caps: { conflictsPerInstance: SAT_MAX_CONFLICTS, propagationsPerInstance: SAT_MAX_PROPAGATIONS } },
      timeBudgetMs: 90000,
      publicSeed: 1,
      provenance:
        'Instances generated from the seed by coordinator/challenges/sat-branching/gen-instances.mjs; nothing is vendored, so no ' +
        'redistribution terms apply. The solver is the second half of coordinator/challenges/sat-branching/harness.js, written ' +
        'for this challenge. Every ' +
        'instance status was cross-checked against CaDiCaL 3.0.1 (arminbiere/cadical, MIT), and `--verify` re-runs that check.',
      publicTrace: path.join(dir('sat-branching'), 'public-instances.json'),
      hiddenTrace: path.join(DATA_DIR, 'sat-branching-hidden-instances.json'),
      artifact: { file: 'heuristic.js', what: 'a CommonJS module' },
      unit: 'conflicts',
      correctnessProof: 'every satisfiable instance came back with an assignment that was checked against every clause, and every unsatisfiable one matched the recorded status',
      shortTitle: 'SAT branching',
      harness: path.join(dir('sat-branching'), 'harness.js'),
      baseline: path.join(dir('sat-branching'), 'baseline.js'),
      directions: ['what to bump and how fast to decay', 'phase selection and phase saving', 'restart policy from the LBD signal', 'clause-based variable ordering before the first conflict', 'treating the structured families differently from the random ones'],
    },} : {}),
  ...(process.env.DMI_ENABLE_COMPRESSION === '1' ? {
  'compression-corpus': {
      id: 'compression-corpus',
      title: 'Lossless compression of a hidden corpus',
      level: 'L2',
      tier: 'main',
      objective: 'compressedBytes',
      direction: 'lower',
      summary:
        'Write a codec. The corpus is twenty documents, about 100 KB each: prose, JSON log lines, CSV tables, ' +
        'source text and fixed-width binary records. The harness builds one compressor instance and hands it ' +
        'every document in order, then builds a second, independent instance in a fresh context and hands that ' +
        'one the compressed outputs in the same order. Every document must come back byte for byte. The score is ' +
        'the compressed payload over the whole corpus plus the byte length of the submitted source, because a ' +
        'table baked into the artifact is bytes the decoder needs just the same. Lower is better. The baseline is ' +
        'an order-1 binary arithmetic coder. Scored on a hidden corpus from another seed: another vocabulary, ' +
        'other service and column names, other identifiers, another document order.',
      constraints: [
        'Artifact is one CommonJS module. module.exports = function createCodec() returning { compress, decompress }. Both take a Uint8Array and must return a Uint8Array.',
        'Round trip is checked first. If any document does not decompress to the original bytes, the submission is invalid and its size is never scored. A smaller wrong answer scores nothing.',
        `compressedBytes = the compressed payload plus the byte length of the source. The source must be under ${COMPRESS_MAX_SOURCE / 1024} KB and every byte of it counts, comments and whitespace included, so an embedded table costs what it weighs.`,
        'The compressor and the decompressor are separate instances in separate VM contexts. They share no globals, no closures, no disk and no clock, so everything the decoder knows has to be in the bytes the encoder returned or in the source itself. One instance does see every document in order, so a model may carry across documents.',
        'No require, no I/O, no timers. Math.random and Date.now are removed: a codec must be deterministic, and two runs of the same source must produce the same bytes. The coordinator reruns every improvement in a second process and compares a fingerprint of the compressed bytes.',
        'Compression and decompression together get 60000 ms of CPU for the whole corpus. The baseline takes about 2.3 s on a laptop and an order-4 context-mixing codec about 14 s.',
        'The public corpus is seed 1. The hidden corpus is another seed of the same generator, so structure carries over and hardcoded words from the public corpus do not.',
      ],
      params: { corpus: COMPRESS_PARAMS, maxSourceBytes: COMPRESS_MAX_SOURCE },
      timeBudgetMs: 60000,
      publicSeed: 1,
      provenance:
        'Generated corpus from coordinator/challenges/compression-corpus/gen-corpus.mjs, deterministic from the seed. ' +
        'Nothing is vendored, so there is no third-party license on the data. Reference points measured on the public ' +
        'corpus as one solid stream: gzip -9 573,202 bytes, zstd -19 431,447, brotli -q 11 407,996, xz -9e 382,192.',
      publicTrace: path.join(dir('compression-corpus'), 'public-corpus.json.gz'),
      hiddenTrace: path.join(DATA_DIR, 'compression-corpus-hidden-trace.json.gz'),
      artifact: { file: 'codec.js', what: 'a CommonJS module' },
      unit: 'bytes',
      correctnessProof: 'every document decompressed to the original bytes, checked before any size was scored',
      shortTitle: 'Lossless compression',
      harness: path.join(dir('compression-corpus'), 'harness.js'),
      baseline: path.join(dir('compression-corpus'), 'baseline.js'),
      directions: ['context mixing over several orders', 'a match model for the repeated records', 'modelling the numeric columns as deltas', 'a secondary estimation stage', 'carrying the model across documents'],
    },} : {}),
  'kv-cache-eviction': {
    id: 'kv-cache-eviction',
    title: 'KV-cache block eviction under synthetic agentic decode (warm-up)',
    level: 'L1',
    tier: 'warmup',
    objective: 'bytesPerToken',
    direction: 'lower',
    summary:
      'Warm-up challenge on a synthetic decode trace. Saturated: a single agent reaches within 1.3 percent of the offline optimum, ' +
      'so it pays participation credit only. Use it to learn the loop, then move to kv-cache-real.',
    constraints: [
      'Artifact is one CommonJS module. module.exports = function createPolicy({ capacity, blockBytes }) returning { onAccess, onEvent, onEvict?, victim }.',
      'victim(residentKeys, req) must return one of residentKeys.',
      'No require, no I/O, no timers. Whole trace must score within 10000 ms.',
      'Public trace is seed 1. The coordinator scores a hidden seed.',
    ],
    params: DEFAULT_PARAMS,
    timeBudgetMs: 10000,
    publicSeed: 1,
    provenance: 'synthetic, coordinator/challenges/kv-cache-eviction/gen-trace.js',
    publicTrace: path.join(dir('kv-cache-eviction'), 'public-trace.json'),
    hiddenTrace: path.join(DATA_DIR, 'hidden-trace.json'),
    artifact: { file: 'policy.js', what: 'a CommonJS module' },
    unit: 'bytes per token',
    correctnessProof: 'every victim was resident',
    shortTitle: 'KV cache, practice',
    harness: path.join(dir('kv-cache-eviction'), 'harness.js'),
    baseline: path.join(dir('kv-cache-eviction'), 'baseline.js'),
    directions: ['finished-sequence handling', 'shared-prefix protection', 'return prediction', 'scan resistance'],
    saturated: true,
  },
}

/**
 * Every entry has to describe itself, because the task payload is built from these fields and nothing
 * else. When they were missing, the payload fell back to the first challenge's shape and told an RTL
 * participant to write policy.js as a CommonJS module, with a Verilog baseline saved under a .js name.
 * A silent default is what made that possible, so there is no default any more: an entry that does not
 * describe itself throws here, at import, and the coordinator never starts with it.
 */
const DESCRIBES_ITSELF = [
  ['objective', (c) => typeof c.objective === 'string' && c.objective],
  ['direction', (c) => c.direction === 'lower' || c.direction === 'higher'],
  ['unit', (c) => typeof c.unit === 'string' && c.unit],
  ['artifact.file', (c) => typeof c.artifact?.file === 'string' && /\.[a-z0-9]+$/i.test(c.artifact.file)],
  ['artifact.what', (c) => typeof c.artifact?.what === 'string' && c.artifact.what],
  ['correctnessProof', (c) => typeof c.correctnessProof === 'string' && c.correctnessProof],
  ['timeBudgetMs', (c) => Number.isFinite(c.timeBudgetMs) && c.timeBudgetMs > 0],
  ['summary', (c) => typeof c.summary === 'string' && c.summary.length > 40],
  ['constraints', (c) => Array.isArray(c.constraints) && c.constraints.length > 0],
]

/** The fields `id` is missing, as a list. Empty means the entry is complete. */
export function undescribed(c) {
  return DESCRIBES_ITSELF.filter(([, ok]) => !ok(c)).map(([name]) => name)
}

/** Throws unless every entry describes itself. Called on this file's own registry at import. */
export function assertDescribed(entries) {
  const bad = Object.values(entries)
    .map((c) => [c.id, undescribed(c)])
    .filter(([, missing]) => missing.length)
  if (bad.length) {
    throw new Error(`challenge registry is incomplete, so the task payload would guess: ${bad.map(([id, m]) => `${id} is missing ${m.join(', ')}`).join('; ')}`)
  }
}
assertDescribed(CHALLENGES)

export const PRIMARY = 'kv-cache-real'

/**
 * Sponsored instances (docs/COMMERCIAL.md item 2). Rows live in sponsored_challenges; each one inherits its base challenge
 * from CHALLENGES and overrides id, title, traces, sponsored, sponsorId and status. They are kept apart from CHALLENGES so
 * the public list, the health check and a bare next_task keep seeing public challenges only. Reload with refreshSponsored().
 */
export const SPONSORED = {}
export function sponsoredFromRow(row) {
  const base = CHALLENGES[row.baseChallenge]
  if (!base) return null
  return {
    ...base,
    id: row.id,
    title: row.title,
    publicTrace: row.publicTracePath,
    hiddenTrace: row.hiddenTracePath,
    sponsored: true,
    sponsorId: row.sponsorId,
    base: base.id,
    status: row.status,
    // Sponsor data is fresh, so the base challenge's saturation does not carry over and improvements pay in full.
    saturated: false,
  }
}
export async function refreshSponsored() {
  // The store is loaded here, not at the top, so the published package (compute nodes, work mode) never loads database code.
  const { db } = await import('./store.js')
  const rows = await db.listSponsoredChallenges()
  for (const k of Object.keys(SPONSORED)) delete SPONSORED[k]
  for (const row of rows) {
    const c = sponsoredFromRow(row)
    const missing = c ? undescribed(c) : []
    if (c && missing.length) console.error(`sponsored challenge ${row.id}: missing ${missing.join(', ')}; skipped`)
    else if (c) SPONSORED[row.id] = c
    else console.error(`sponsored challenge ${row.id}: base ${row.baseChallenge} is not in the registry; skipped`)
  }
  return SPONSORED
}
export const getChallenge = (id) => (id == null ? CHALLENGES[PRIMARY] : CHALLENGES[id] ?? SPONSORED[id] ?? null)
/**
 * The challenge id a compute node must report to run this challenge. A sponsored instance needs the same tools as its
 * base challenge, so it routes on the base id. `tools` on a registry entry names what the node probes for
 * (cli/compute.js): nothing for L1, `ramulator` for dram-controller, `verilator` plus a C++ compiler for rtl-cache-controller,
 * and `yosys` on top of those for rtl-synth-fifo.
 */
export const capabilityOf = (c) => c.base ?? c.id
export const harnessSource = (c) => fs.readFileSync(c.harness, 'utf8')
export const baselineSource = (c) => fs.readFileSync(c.baseline, 'utf8')

/** Synthetic traces are generated here. Real-trace windows are bundled gzipped: the public one under the challenge dir, the hidden one under coordinator/hidden, which is never exported or served. */
// The test suite points this at a test-owned directory (scripts/test-bootstrap.mjs), so a clone without coordinator/hidden still boots.
const HIDDEN_DIR = process.env.DMI_HIDDEN_DIR ?? path.join(here, 'hidden')
/** Generated public traces go next to the challenge when that directory is writable, else into DATA_DIR (read-only images). */
function writableTracePath(c, filename) {
  const preferred = c.publicTrace
  try { fs.accessSync(path.dirname(preferred), fs.constants.W_OK); return preferred } catch { const p = path.join(DATA_DIR, filename); c.publicTrace = p; return p }
}
export function ensureTraces() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const syn = CHALLENGES['kv-cache-eviction']
  const synPublic = fs.existsSync(syn.publicTrace) ? syn.publicTrace : writableTracePath(syn, 'kv-cache-eviction-public-trace.json')
  if (!fs.existsSync(synPublic)) fs.writeFileSync(synPublic, JSON.stringify(generateTrace(syn.publicSeed)))
  const hiddenSeed = Number(process.env.DMI_HIDDEN_SEED ?? 13)
  const current = fs.existsSync(syn.hiddenTrace) ? JSON.parse(fs.readFileSync(syn.hiddenTrace, 'utf8')).seed : null
  if (current !== hiddenSeed) fs.writeFileSync(syn.hiddenTrace, JSON.stringify(generateTrace(hiddenSeed)))

  if (CHALLENGES['dram-controller']) {
    const dram = CHALLENGES['dram-controller']
    const dramPublic = fs.existsSync(dram.publicTrace) ? dram.publicTrace : writableTracePath(dram, 'dram-controller-public-trace.trace')
    ensureDramTraces({ publicPath: dramPublic, hiddenPath: dram.hiddenTrace, publicSeed: dram.publicSeed, hiddenSeed })
  }
  if (CHALLENGES['rtl-cache-controller']) {
    const rtl = CHALLENGES['rtl-cache-controller']
    const rtlPublic = fs.existsSync(rtl.publicTrace) ? rtl.publicTrace : writableTracePath(rtl, 'rtl-cache-controller-public-trace.trace')
    ensureRtlTraces({ publicPath: rtlPublic, hiddenPath: rtl.hiddenTrace, publicSeed: rtl.publicSeed, hiddenSeed })
  }
  if (CHALLENGES['rtl-synth-fifo']) {
    const synth = CHALLENGES['rtl-synth-fifo']
    const synthPublic = fs.existsSync(synth.publicTrace) ? synth.publicTrace : writableTracePath(synth, 'rtl-synth-fifo-public-trace.trace')
    ensureSynthTraces({ publicPath: synthPublic, hiddenPath: synth.hiddenTrace, publicSeed: synth.publicSeed, hiddenSeed })
  }
  if (CHALLENGES['matmul-cpu']) {
    const mm = CHALLENGES['matmul-cpu']
    const mmPublic = fs.existsSync(mm.publicTrace) ? mm.publicTrace : writableTracePath(mm, 'matmul-cpu-public-inputs.json')
    ensureMatmulInputs({ publicPath: mmPublic, hiddenPath: mm.hiddenTrace, publicSeed: mm.publicSeed, hiddenSeed })
  }
  if (CHALLENGES['lean-proofs']) {
    const lp = CHALLENGES['lean-proofs']
    const lpPublic = fs.existsSync(lp.publicTrace) ? lp.publicTrace : writableTracePath(lp, 'lean-proofs-public-problems.json')
    ensureLeanProblems({ publicPath: lpPublic, hiddenPath: lp.hiddenTrace, publicSeed: lp.publicSeed, hiddenSeed })
  }
  if (CHALLENGES['gemm-cuda']) {
    const gg = CHALLENGES['gemm-cuda']
    const ggPublic = fs.existsSync(gg.publicTrace) ? gg.publicTrace : writableTracePath(gg, 'gemm-cuda-public-inputs.json')
    ensureGemmInputs({ publicPath: ggPublic, hiddenPath: gg.hiddenTrace, publicSeed: gg.publicSeed, hiddenSeed })
  }
  if (CHALLENGES['sat-branching']) {
    const sat = CHALLENGES['sat-branching']
    const satPublic = fs.existsSync(sat.publicTrace) ? sat.publicTrace : writableTracePath(sat, 'sat-branching-public-instances.json')
    ensureSatInstances({ publicPath: satPublic, hiddenPath: sat.hiddenTrace, publicSeed: sat.publicSeed, hiddenSeed })
  }
  if (CHALLENGES['compression-corpus']) {
    const comp = CHALLENGES['compression-corpus']
    const compPublic = fs.existsSync(comp.publicTrace) ? comp.publicTrace : writableTracePath(comp, 'compression-corpus-public-corpus.json.gz')
    ensureCompressionCorpora({ publicPath: compPublic, hiddenPath: comp.hiddenTrace, publicSeed: comp.publicSeed, hiddenSeed })
  }
  const real = CHALLENGES['kv-cache-real']
  const local = path.join(HIDDEN_DIR, 'kv-cache-real-hidden-trace.json.gz')
  if (!fs.existsSync(real.hiddenTrace) && fs.existsSync(local)) fs.copyFileSync(local, real.hiddenTrace)
  for (const c of Object.values(CHALLENGES)) {
    if (!fs.existsSync(c.publicTrace)) throw new Error(`${c.id}: missing public trace ${c.publicTrace}`)
    if (!fs.existsSync(c.hiddenTrace)) console.error(`${c.id}: hidden trace missing at ${c.hiddenTrace}; upload it with PUT /v1/admin/challenges/${c.id}/hidden-trace`)
  }
}
