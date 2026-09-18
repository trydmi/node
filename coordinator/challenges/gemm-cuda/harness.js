/**
 * DMI challenge harness: gemm-cuda (L2, kind timing). A 4096 x 4096 fp32 GEMM in CUDA, timed on the participant's
 * own NVIDIA GPU. The node that runs the job is the card being measured.
 *
 * Shipped to every participant inside the task payload. The SAME code the coordinator runs on the hidden inputs.
 * This file is a thin wrapper: the scoring logic is the generic contest harness in ../_contest/harness.js, and the
 * challenge-provided pieces are run.cu (the driver) and baseline.cu (the reference kernel) in this directory.
 *
 * Submission contract: one CUDA file, under 64 KB, that defines
 *   extern "C" void dmi_sgemm(const float* A, const float* B, float* C, int n);
 * A, B and C are DEVICE pointers, row major. C is zeroed on the device before every call. C = A * B. The launch
 * goes on the default stream and the driver synchronizes. The kernel may not allocate or copy: the driver owns
 * every byte of device memory, so nothing can hide a transfer inside the timed window.
 *
 * Scoring: outputs must match the reference on hidden random inputs (atol 1e-2, rtol 2e-3, every element) before
 * any timing counts. Then the kernel runs 7 passes and the median pass time in ms is the objective.
 * Hardware class nvidia-geforce-rtx-4090, agreement band 10 percent, because two cards of the same model still
 * differ in power limit, cooling and host.
 *
 * NOT RUN ON THE MACHINE THAT WROTE THIS FILE. It was written on an Apple M5 Pro: Metal, no CUDA GPU, no nvcc.
 * The rules, the parsing, the routing and the registry entry are tested here (test/gpu.test.mjs). Compiling,
 * running and timing are not. The harness fails with a message that names the missing tool rather than degrading:
 * a missing nvcc throws before any compile, and run.cu exits non-zero when no CUDA device is visible.
 *
 * Run locally on a GPU node: node coordinator/challenges/gemm-cuda/harness.js examples/gemm-cuda-tiled.cu
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createContestHarness, ensureContestInputs } from '../_contest/harness.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * The card this challenge is scored on. A 4090 result and an H100 result are not comparable, so the class is part
 * of the challenge: coordinator/compute.js only routes a timing job to a node whose reported hardware class is
 * this string, and cli/compute.js probeHardware() builds it from `nvidia-smi --query-gpu=name`.
 *
 * "NVIDIA GeForce RTX 4090" normalizes to this. That name string has NOT been read off a real card here, because
 * there is no NVIDIA GPU on this machine. A node whose nvidia-smi prints something else sets DMI_HARDWARE to
 * override the probe, and the value to fix is this constant.
 */
export const HARDWARE_CLASS = 'nvidia-geforce-rtx-4090'
/** The SM architecture that class implies. Ada Lovelace, so sm_89. nvcc is given exactly this target. */
export const GPU_ARCH = 'sm_89'
/**
 * The CUDA toolkit the score is defined against. nvcc's scheduler, its unrolling and its register allocation move
 * between releases, so the same kernel is a different number on a different toolkit. A node reports this challenge
 * only when `nvcc --version` prints this release (registry `toolVersions.nvcc`), the same rule rtl-synth-fifo uses
 * for Yosys. The evaluator image (Dockerfile in this directory) is where the pinned toolkit comes from.
 */
export const CUDA_RELEASE = '12.6'
export const REPEATS = 7
/**
 * How far two honest scorers may differ before they are called a disagreement.
 *
 * Ten percent, the same band matmul-cpu settled on, and for a wider reason. Two nodes in this class are two
 * different physical 4090s: different board partners, different power limits, different cooling, different host
 * CPUs. A card at its power limit clocks down mid-run. The cross-node spread is what the band has to cover, and it
 * is larger than the run-to-run spread on one card.
 *
 * This number is a starting value, not a measurement: no two 4090 nodes have reported on it yet. Tighten it once
 * they have. DMI_TIMING_TOLERANCE_PCT widens the band on a machine known to be busy, such as CI.
 */
export const TOLERANCE_PCT = Number(process.env.DMI_TIMING_TOLERANCE_PCT ?? 10)
export const SHAPE = { n: 4096, cases: 2 }
export const ENTRY = 'extern "C" void dmi_sgemm(const float* A, const float* B, float* C, int n)'
/**
 * The correctness band, and the line that decides which arithmetic qualifies.
 *
 * Sums of 4096 products of values in [-1, 1) land around magnitude 20, and reordering an fp32 sum of that length
 * moves the result by roughly n * eps * partial, about 1e-2. So atol 1e-2 plus rtol 2e-3 (about 4e-2 at |ref| 20)
 * passes any honest reordering of the same fp32 work and rejects a kernel that skips or corrupts elements.
 *
 * It also settles reduced precision without a token ban. Nothing in the source is checked for wmma or mma.sync,
 * because inline PTX makes that unenforceable. A tensor-core path counts if and only if its output passes this
 * band on the hidden inputs. tf32 sits close to the line, which is the intended answer: it is allowed when it is
 * accurate enough on the day, and rejected when it is not.
 *
 * DERIVED, NOT MEASURED. The bound above is arithmetic, not an observation, and no kernel has been run against it.
 * The first real run on a 4090 is what confirms the number, and it is the first thing to re-check there.
 */
export const TOLERANCE = { atol: 1e-2, rtol: 2e-3, matchRatio: 1 }
/** nvcc flags. Fixed by the challenge, so no submission can add -lcublas or a different -arch. */
export const NVCC_FLAGS = ['-O3', '-std=c++17', `-arch=${GPU_ARCH}`]

/**
 * Includes a kernel may use. This is the real gate on library GEMMs: cublas_v2.h, cublasLt.h, cudnn.h and
 * cutlass headers are not on the list, and the flags above link no library, so calling a vendor GEMM does not
 * build. The challenge is the kernel, not the call.
 */
export const ALLOWED_INCLUDES = [
  'cuda_runtime.h', 'cuda_runtime_api.h', 'cuda_fp16.h', 'cuda_bf16.h', 'mma.h', 'cooperative_groups.h',
  'cuda/pipeline', 'cuda/barrier',
  'cstddef', 'cstdint', 'cmath', 'cstring', 'algorithm', 'stdint.h', 'stddef.h', 'math.h', 'string.h',
]
/**
 * Tokens a kernel may not use.
 *
 * Host escapes (system, exec, fork, dlopen, sockets) are refused the way every other challenge refuses them.
 * Device memory management is refused too: the driver owns A, B and C, so a submission cannot allocate, free or
 * copy, and cannot move work out of the timed window into a setup call.
 *
 * `asm` is NOT on this list, unlike matmul-cpu. On a GPU, mma.sync and ldmatrix are reached through inline PTX,
 * and banning it would rule out the fastest honest kernels. The container the evaluator runs in is the boundary;
 * these rules are a courtesy that gives a clear message before the compiler does.
 */
export const BANNED_TOKENS = [
  'system', 'popen', 'fopen', 'freopen', 'exec', 'execve', 'execl', 'fork', 'vfork', 'dlopen', 'dlsym',
  'socket', 'connect', 'mmap', 'mprotect', 'ptrace', 'syscall', 'signal', 'raise', 'abort', 'exit', '_exit',
  'atexit', 'getenv', 'setenv', 'main', '__attribute__', 'constructor', 'destructor', 'omp', 'pthread_create',
  'cudaMalloc', 'cudaMallocHost', 'cudaMallocManaged', 'cudaMallocAsync', 'cudaHostAlloc', 'cudaFree',
  'cudaMemcpy', 'cudaMemcpyAsync', 'cudaMemcpyToSymbol', 'cudaSetDevice', 'cudaDeviceReset',
  'cublasCreate', 'cublasSgemm', 'cublasGemmEx', 'cublasLtMatmul', 'cudnnCreate',
  'dmi_contest_result',
]

export const SPEC = {
  id: 'gemm-cuda',
  language: 'cpp',
  entry: /extern\s+"C"\s+void\s+dmi_sgemm\s*\(\s*const\s+float\s*\*\s*(?:__restrict__\s+)?\w+\s*,\s*const\s+float\s*\*\s*(?:__restrict__\s+)?\w+\s*,\s*float\s*\*\s*(?:__restrict__\s+)?\w+\s*,\s*int\s+\w+\s*\)/,
  entryText: ENTRY,
  runner: {
    driver: path.join(here, 'run.cu'),
    reference: path.join(here, 'baseline.cu'),
    cxxflags: NVCC_FLAGS,
    // nvcc, never the host C++ compiler: a missing toolkit has to fail by name, not as a syntax error on <<<>>>.
    compiler: { bin: 'nvcc', env: 'DMI_NVCC_BIN', what: `CUDA toolkit ${CUDA_RELEASE}` },
    sourceExt: 'cu',
  },
  repeats: REPEATS,
  tolerance: TOLERANCE,
  hardwareClass: HARDWARE_CLASS,
  allowedIncludes: ALLOWED_INCLUDES,
  bannedTokens: BANNED_TOKENS,
  // #pragma unroll is one of the optimisations being measured. #pragma omp is still refused by the omp token.
  allowedDirectives: ['include', 'define', 'undef', 'if', 'ifdef', 'ifndef', 'elif', 'else', 'endif', 'pragma'],
}

const h = createContestHarness(SPEC)
export const { loadPolicySource, simulate, loadTrace } = h

/** An executable: the env override if set, else `name` on PATH. Null when neither is there. */
function findBinary(name, envKey) {
  const bin = process.env[envKey]
  if (bin) return fs.existsSync(bin) ? bin : null
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    const p = path.join(d, name)
    // Inside the evaluator worker the permission model denies the stat; the child process itself is not restricted.
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch (e) { if (e?.code === 'ERR_ACCESS_DENIED') return p }
  }
  return null
}
export const resolveNvcc = () => findBinary('nvcc', 'DMI_NVCC_BIN')
/** Is there a CUDA compiler here? Used to skip the GPU half of the tests instead of pretending it ran. */
export const haveNvcc = () => resolveNvcc() != null
/** Is there an NVIDIA GPU here? nvidia-smi answering is the cheapest honest signal; the driver checks for real. */
export const haveNvidiaGpu = () => findBinary('nvidia-smi', 'DMI_NVIDIA_SMI_BIN') != null
export const haveTools = () => haveNvcc() && haveNvidiaGpu()
/** Why the GPU half cannot run here, or null when it can. */
export const missingTools = () => (haveTools() ? null : [haveNvcc() ? null : 'nvcc is not on PATH and DMI_NVCC_BIN is not set', haveNvidiaGpu() ? null : 'nvidia-smi is not on PATH, so there is no NVIDIA GPU on this machine'].filter(Boolean).join('; '))

/** Public inputs are seed 1; hidden inputs are the coordinator's hidden seed. Both are tiny JSON files. */
export const ensureGemmInputs = ({ publicPath, hiddenPath, publicSeed = 1, hiddenSeed = 13 }) => ensureContestInputs({ publicPath, hiddenPath, publicSeed, hiddenSeed, shape: SHAPE })

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const [kernelFile, inputsFile = path.join(here, 'public-inputs.json')] = process.argv.slice(2)
  if (!kernelFile) { console.error('usage: node harness.js <kernel.cu> [inputs.json]'); process.exit(2) }
  const missing = missingTools()
  if (missing) { console.error(`gemm-cuda cannot run on this machine: ${missing}`); process.exit(3) }
  console.log(JSON.stringify(simulate(loadTrace(inputsFile), loadPolicySource(fs.readFileSync(kernelFile, 'utf8'))), null, 2))
}
