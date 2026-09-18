// name: naive-global
// strategy: one thread per output element, the whole dot product read straight from global memory. Threads in a
// warp share the same row of A and walk contiguous columns of B, so B is coalesced and A is broadcast, but every
// element of A and B is read n times.
//
// This is the reference. The correctness gate compares every submission against these outputs, so it also fixes
// the numerics: the sum runs in fp32, k ascending, one element at a time.
//
// NOT COMPILED on the machine that wrote it: no nvcc, no CUDA GPU. See README.md.
#include <cuda_runtime.h>

__global__ void dmi_gemm_naive(const float* __restrict__ A, const float* __restrict__ B, float* __restrict__ C, int n) {
  int j = blockIdx.x * blockDim.x + threadIdx.x;
  int i = blockIdx.y * blockDim.y + threadIdx.y;
  if (i >= n || j >= n) return;
  float acc = 0.0f;
  for (int k = 0; k < n; k++) acc += A[i * n + k] * B[k * n + j];
  C[i * n + j] = acc;
}

extern "C" void dmi_sgemm(const float* A, const float* B, float* C, int n) {
  dim3 block(32, 8);
  dim3 grid((unsigned)((n + 31) / 32), (unsigned)((n + 7) / 8));
  dmi_gemm_naive<<<grid, block>>>(A, B, C, n);
}
