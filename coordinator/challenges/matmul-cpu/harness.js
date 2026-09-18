/**
 * DMI challenge harness: matmul-cpu (L1, kind timing). A 512 x 512 float matmul in C++, timed on a laptop CPU.
 *
 * Shipped to every participant inside the task payload. The SAME code the coordinator runs on the hidden inputs.
 * This file is a thin wrapper: the scoring logic is the generic contest harness in ../_contest/harness.js, and the
 * contest-provided pieces are run.cpp (the driver) and baseline.cpp (the reference kernel) in this directory.
 *
 * Submission contract: one C++ file, under 64 KB, that defines
 *   extern "C" void dmi_matmul(const float* A, const float* B, float* C, int n);
 * Row major, C is zeroed before every call, C = A * B. Single thread. Allowed includes: cstddef, cstdint, cmath,
 * cstring, algorithm, immintrin.h, arm_neon.h. No asm, no threads, no I/O, no main.
 *
 * Scoring: outputs must match the reference on hidden random inputs (atol 1e-3, rtol 1e-3, every element) before
 * any timing counts. Then the kernel runs 5 passes over the inputs and the median pass time in ms is the objective.
 * Hardware class cpu-generic, agreement band 10 percent, because laptops vary.
 *
 * Run locally: node coordinator/challenges/matmul-cpu/harness.js examples/matmul-blocked.cpp
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createContestHarness, ensureContestInputs } from '../_contest/harness.js'

const here = path.dirname(fileURLToPath(import.meta.url))

export const HARDWARE_CLASS = 'cpu-generic'
export const REPEATS = 5
/**
 * How far two honest scorers may differ before they are called a disagreement.
 *
 * Ten percent is right on a quiet machine and wrong on a busy one. This objective is wall-clock
 * time, so a loaded box stretches a run past the band and two correct nodes get recorded as
 * disagreeing. That is not a hypothetical: it failed twice in one suite run while three builds
 * were running beside it, and passed alone seconds later.
 *
 * DMI_TIMING_TOLERANCE_PCT widens the band for a machine that is known to be busy, such as CI or a
 * laptop running the whole suite. Production leaves it unset and keeps the honest 10 percent,
 * because a real disagreement there has to mean something.
 */
export const TOLERANCE_PCT = Number(process.env.DMI_TIMING_TOLERANCE_PCT ?? 10)
export const SHAPE = { n: 512, cases: 2 }
export const ENTRY = 'extern "C" void dmi_matmul(const float* A, const float* B, float* C, int n)'

export const SPEC = {
  id: 'matmul-cpu',
  language: 'cpp',
  entry: /extern\s+"C"\s+void\s+dmi_matmul\s*\(\s*const\s+float\s*\*\s*\w+\s*,\s*const\s+float\s*\*\s*\w+\s*,\s*float\s*\*\s*\w+\s*,\s*int\s+\w+\s*\)/,
  entryText: ENTRY,
  runner: { driver: path.join(here, 'run.cpp'), reference: path.join(here, 'baseline.cpp'), cxxflags: ['-O2', '-std=c++17'] },
  repeats: REPEATS,
  tolerance: { atol: 1e-3, rtol: 1e-3, matchRatio: 1 },
  hardwareClass: HARDWARE_CLASS,
}

const h = createContestHarness(SPEC)
export const { loadPolicySource, simulate, loadTrace } = h

/** Public inputs are seed 1; hidden inputs are the coordinator's hidden seed. Both are tiny JSON files. */
export const ensureMatmulInputs = ({ publicPath, hiddenPath, publicSeed = 1, hiddenSeed = 13 }) => ensureContestInputs({ publicPath, hiddenPath, publicSeed, hiddenSeed, shape: SHAPE })

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const [kernelFile, inputsFile = path.join(here, 'public-inputs.json')] = process.argv.slice(2)
  if (!kernelFile) { console.error('usage: node harness.js <kernel.cpp> [inputs.json]'); process.exit(2) }
  console.log(JSON.stringify(simulate(loadTrace(inputsFile), loadPolicySource(fs.readFileSync(kernelFile, 'utf8'))), null, 2))
}
