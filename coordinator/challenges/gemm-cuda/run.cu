// Driver for gemm-cuda. Challenge-provided, trusted, compiled by nvcc together with the submitted kernel.
//
// NOT BUILT ON THE MACHINE THAT WROTE THIS FILE. There is no CUDA GPU and no nvcc here, so this file has never
// been compiled or run. Every line below is written against the CUDA runtime API as documented. The first run on
// a real card is the first time it is checked. See README.md, "What is unverified".
//
// The runner protocol (coordinator/challenges/_contest/harness.js):
//   run --seed S --n N --cases K --repeats R --out DIR
// generates K pairs of N x N float matrices from the seed on the host (mulberry32, the same generator every DMI
// trace uses), copies them to the device once, calls the kernel once to warm up, then R times, timing each pass
// over all K cases with steady_clock around the launch plus cudaDeviceSynchronize.
//
// It writes DIR/outputs.bin (float32, every case's C in order, copied back after the last timed pass) and
// DIR/result.json with the per-pass times in milliseconds. The harness compares outputs.bin against the
// reference run and takes the median of timesMs.
//
// Kernel signature the submission must define:
//   extern "C" void dmi_sgemm(const float* A, const float* B, float* C, int n);
// A, B and C are device pointers. Row major. C is zeroed on the device before every call. C = A * B.
// The launch goes on the default stream. The driver synchronizes, so the kernel does not have to.
#include <cuda_runtime.h>

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

extern "C" void dmi_sgemm(const float* A, const float* B, float* C, int n);

// Every CUDA call is checked. A silent failure here would be timed as a very fast kernel.
#define CUDA_CHECK(call)                                                                              \
  do {                                                                                               \
    cudaError_t e_ = (call);                                                                          \
    if (e_ != cudaSuccess) {                                                                          \
      fprintf(stderr, "cuda error at %s:%d: %s (%s)\n", __FILE__, __LINE__, cudaGetErrorName(e_),      \
              cudaGetErrorString(e_));                                                                \
      return 4;                                                                                       \
    }                                                                                                 \
  } while (0)

static uint32_t mulberry32(uint32_t& s) {
  s += 0x6D2B79F5u;
  uint32_t t = s;
  t = (t ^ (t >> 15)) * (t | 1u);
  t ^= t + (t ^ (t >> 7)) * (t | 61u);
  return t ^ (t >> 14);
}
static void fill(std::vector<float>& m, uint32_t& s) { for (auto& x : m) x = 2.0f * (float)(mulberry32(s) / 4294967296.0) - 1.0f; }

int main(int argc, char** argv) {
  long seed = 1, n = 4096, cases = 1, repeats = 7;
  std::string out;
  for (int i = 1; i + 1 < argc; i += 2) {
    std::string k = argv[i];
    if (k == "--seed") seed = atol(argv[i + 1]);
    else if (k == "--n") n = atol(argv[i + 1]);
    else if (k == "--cases") cases = atol(argv[i + 1]);
    else if (k == "--repeats") repeats = atol(argv[i + 1]);
    else if (k == "--out") out = argv[i + 1];
    else { fprintf(stderr, "unknown argument %s\n", argv[i]); return 2; }
  }
  if (out.empty() || n < 1 || n > 8192 || cases < 1 || cases > 8 || repeats < 1 || repeats > 1000) { fprintf(stderr, "bad arguments\n"); return 2; }

  // No card, no run. The message says so, instead of a kernel that times as instant.
  int devices = 0;
  cudaError_t countErr = cudaGetDeviceCount(&devices);
  if (countErr != cudaSuccess || devices < 1) {
    fprintf(stderr, "no CUDA device is visible to this process (%s). This challenge only runs on a GPU node.\n",
            countErr == cudaSuccess ? "cudaGetDeviceCount returned 0 devices" : cudaGetErrorString(countErr));
    return 5;
  }
  cudaDeviceProp prop{};
  CUDA_CHECK(cudaGetDeviceProperties(&prop, 0));
  fprintf(stderr, "device 0: %s, sm_%d%d\n", prop.name, prop.major, prop.minor);

  const size_t elems = (size_t)n * n;
  const size_t bytes = elems * sizeof(float);
  std::vector<std::vector<float>> hA(cases, std::vector<float>(elems)), hB(cases, std::vector<float>(elems));
  for (long c = 0; c < cases; c++) { uint32_t s = (uint32_t)(seed * 1000003L + c); fill(hA[c], s); fill(hB[c], s); }

  std::vector<float*> dA(cases, nullptr), dB(cases, nullptr), dC(cases, nullptr);
  for (long c = 0; c < cases; c++) {
    CUDA_CHECK(cudaMalloc(&dA[c], bytes));
    CUDA_CHECK(cudaMalloc(&dB[c], bytes));
    CUDA_CHECK(cudaMalloc(&dC[c], bytes));
    CUDA_CHECK(cudaMemcpy(dA[c], hA[c].data(), bytes, cudaMemcpyHostToDevice));
    CUDA_CHECK(cudaMemcpy(dB[c], hB[c].data(), bytes, cudaMemcpyHostToDevice));
  }

  // Warm-up pass, not timed: it pays the module load, the first launch and the clock ramp.
  for (long c = 0; c < cases; c++) {
    CUDA_CHECK(cudaMemset(dC[c], 0, bytes));
    dmi_sgemm(dA[c], dB[c], dC[c], (int)n);
  }
  CUDA_CHECK(cudaDeviceSynchronize());
  CUDA_CHECK(cudaGetLastError());

  std::vector<double> times;
  for (long r = 0; r < repeats; r++) {
    double ms = 0;
    for (long c = 0; c < cases; c++) {
      // The zeroing and the sync that follows it are outside the timed window, so the number is the kernel.
      CUDA_CHECK(cudaMemset(dC[c], 0, bytes));
      CUDA_CHECK(cudaDeviceSynchronize());
      auto t0 = std::chrono::steady_clock::now();
      dmi_sgemm(dA[c], dB[c], dC[c], (int)n);
      CUDA_CHECK(cudaDeviceSynchronize());
      auto t1 = std::chrono::steady_clock::now();
      // A launch error is a failed pass, not a fast one.
      CUDA_CHECK(cudaGetLastError());
      ms += std::chrono::duration<double, std::milli>(t1 - t0).count();
    }
    times.push_back(ms);
  }

  // Outputs come from the last timed pass, so a kernel that stops working once it is timed is caught.
  std::vector<float> hC(elems);
  FILE* f = fopen((out + "/outputs.bin").c_str(), "wb");
  if (!f) { fprintf(stderr, "cannot write outputs\n"); return 3; }
  for (long c = 0; c < cases; c++) {
    CUDA_CHECK(cudaMemcpy(hC.data(), dC[c], bytes, cudaMemcpyDeviceToHost));
    if (fwrite(hC.data(), sizeof(float), elems, f) != elems) { fprintf(stderr, "short write\n"); fclose(f); return 3; }
  }
  fclose(f);

  FILE* j = fopen((out + "/result.json").c_str(), "w");
  if (!j) { fprintf(stderr, "cannot write result\n"); return 3; }
  fprintf(j, "{\"timesMs\":[");
  for (size_t i = 0; i < times.size(); i++) fprintf(j, "%s%.6f", i ? "," : "", times[i]);
  fprintf(j, "],\"elements\":%zu,\"cases\":%ld,\"n\":%ld,\"device\":\"%s\"}\n", elems * (size_t)cases, cases, n, prop.name);
  fclose(j);

  for (long c = 0; c < cases; c++) { cudaFree(dA[c]); cudaFree(dB[c]); cudaFree(dC[c]); }
  return 0;
}
