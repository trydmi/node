# _contest: the generic contest harness

Not a challenge. A library every contest-mirror challenge wraps (design: `docs/internal/CONTEST_MIRROR.md`). The first
wrapper is `../matmul-cpu`, which runs on any machine with a C++ compiler. The second is `../gemm-cuda`, which runs
only on a node with an NVIDIA GPU and the pinned CUDA toolkit.

## Files

| File | What it is |
| --- | --- |
| `harness.js` | `createContestHarness(spec)` returns the `{ loadPolicySource, simulate, loadTrace }` trio the evaluator worker imports. Also exports `normalizeHardware` and `ensureContestInputs`. The tolerance band itself (`withinTolerance`) lives in `coordinator/evaluate.js`. |
| `Dockerfile.cuda` | Evaluator or node image for NVIDIA cards: CUDA 12.6, PyTorch, Triton, Node 22. Unverified draft. |
| `Dockerfile.rocm` | Same for AMD cards on ROCm 6.4. Unverified draft. |

## Runner protocol

A contest gives DMI a runner and a reference kernel. The harness calls the runner as

```
<runner> [--kernel FILE] --<field> <value>... --repeats R --out DIR
```

with one `--field value` pair per field of the inputs file (a JSON object such as `{"seed":13,"n":512,"cases":2}`).
The runner generates the inputs from those fields, warms up once, runs the kernel R times, and writes:

- `DIR/outputs.bin`: every output element as float32, little endian, in a fixed order, from the last pass
- `DIR/result.json`: `{ "timesMs": [..R numbers..], "elements": M }`

For a C++ runner (`spec.runner = { driver, reference, cxxflags }`) the harness compiles `driver + kernel` into one
executable and runs it. For a Python runner (`spec.runner = { script, reference, python }`) it runs
`python3 script --kernel kernel.py ...`. The reference kernel goes through the same runner in a separate process.

A C++ runner may pin its own compiler and its own source extension:

- `spec.runner.compiler = { bin, env, what }`, e.g. `{ bin: 'nvcc', env: 'DMI_NVCC_BIN' }`. With it set the harness
  never falls back to the host C++ compiler. A challenge whose score is the compiler's output has to stop with a
  message naming the missing binary, not score on whatever else is on PATH. Without it, the compiler is
  `DMI_CXX_BIN`, then `CXX`, then `c++`, as before.
- `spec.runner.sourceExt`, e.g. `cu`, because nvcc reads the extension to decide the file is device code.
- `spec.allowedDirectives` widens the preprocessor allowlist. `gemm-cuda` adds `pragma` for `#pragma unroll`.

## What simulate() does, in order

1. static rules on the source (size, entry point, banned tokens, include allowlist)
2. compile (C++ only)
3. reference run, once, dumps the reference outputs
4. correctness run of the submission, once; every element compared with `atol + rtol * |ref|`; a miss throws
   `rejected before timing: ...` and nothing else runs
5. timing run, `repeats` passes; `medianMs` is the objective; the outputs of that pass are compared again, so a
   kernel that does less work once it is being timed is rejected

The result carries `medianMs`, `minMs`, `maxMs`, `referenceMs`, `matchRatio`, `maxAbsErr`, `outputHash`,
`hardwareClass`, `fingerprint` (a hash of the normalized source, since every correct kernel has the same outputs),
`compileMs` and `wallMs`.

The static rules are a courtesy to the submitter. The container is the boundary.
