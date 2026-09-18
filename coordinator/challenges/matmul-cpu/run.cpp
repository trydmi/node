// Contest driver for matmul-cpu. Contest-provided, trusted, compiled together with the submitted kernel.
//
// The runner protocol (coordinator/challenges/_contest/harness.js):
//   run --seed S --n N --cases K --repeats R --out DIR
// generates K pairs of N x N float matrices from the seed (mulberry32, the same generator every DMI trace uses),
// calls the kernel once to warm up, then R times, timing each pass over all K cases with steady_clock.
// It writes DIR/outputs.bin (float32, every case's C in order, from the last pass) and DIR/result.json with
// the per-pass times in milliseconds. The harness compares outputs.bin against the reference run and takes the
// median of timesMs.
//
// Kernel signature the submission must define:
//   extern "C" void dmi_matmul(const float* A, const float* B, float* C, int n);
// C is zeroed before every call. Row major. C = A * B.
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

extern "C" void dmi_matmul(const float* A, const float* B, float* C, int n);

static uint32_t mulberry32(uint32_t& s) {
  s += 0x6D2B79F5u;
  uint32_t t = s;
  t = (t ^ (t >> 15)) * (t | 1u);
  t ^= t + (t ^ (t >> 7)) * (t | 61u);
  return t ^ (t >> 14);
}
static void fill(std::vector<float>& m, uint32_t& s) { for (auto& x : m) x = 2.0f * (float)(mulberry32(s) / 4294967296.0) - 1.0f; }

int main(int argc, char** argv) {
  long seed = 1, n = 512, cases = 1, repeats = 5;
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
  if (out.empty() || n < 1 || n > 4096 || cases < 1 || cases > 16 || repeats < 1 || repeats > 1000) { fprintf(stderr, "bad arguments\n"); return 2; }
  const size_t elems = (size_t)n * n;
  std::vector<std::vector<float>> A(cases, std::vector<float>(elems)), B(cases, std::vector<float>(elems)), C(cases, std::vector<float>(elems));
  for (long c = 0; c < cases; c++) { uint32_t s = (uint32_t)(seed * 1000003L + c); fill(A[c], s); fill(B[c], s); }

  // Warm-up pass, not timed.
  for (long c = 0; c < cases; c++) { memset(C[c].data(), 0, elems * sizeof(float)); dmi_matmul(A[c].data(), B[c].data(), C[c].data(), (int)n); }
  std::vector<double> times;
  for (long r = 0; r < repeats; r++) {
    double ms = 0;
    for (long c = 0; c < cases; c++) {
      memset(C[c].data(), 0, elems * sizeof(float));
      auto t0 = std::chrono::steady_clock::now();
      dmi_matmul(A[c].data(), B[c].data(), C[c].data(), (int)n);
      auto t1 = std::chrono::steady_clock::now();
      ms += std::chrono::duration<double, std::milli>(t1 - t0).count();
    }
    times.push_back(ms);
  }

  FILE* f = fopen((out + "/outputs.bin").c_str(), "wb");
  if (!f) { fprintf(stderr, "cannot write outputs\n"); return 3; }
  for (long c = 0; c < cases; c++) fwrite(C[c].data(), sizeof(float), elems, f);
  fclose(f);
  FILE* j = fopen((out + "/result.json").c_str(), "w");
  if (!j) { fprintf(stderr, "cannot write result\n"); return 3; }
  fprintf(j, "{\"timesMs\":[");
  for (size_t i = 0; i < times.size(); i++) fprintf(j, "%s%.6f", i ? "," : "", times[i]);
  fprintf(j, "],\"elements\":%zu,\"cases\":%ld,\"n\":%ld}\n", elems * cases, cases, n);
  fclose(j);
  return 0;
}
