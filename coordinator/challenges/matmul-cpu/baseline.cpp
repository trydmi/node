// name: naive-ijk
// strategy: the textbook triple loop, k innermost, so every step of the inner loop strides down a column of B
extern "C" void dmi_matmul(const float* A, const float* B, float* C, int n) {
  for (int i = 0; i < n; i++)
    for (int j = 0; j < n; j++) {
      float acc = 0.0f;
      for (int k = 0; k < n; k++) acc += A[i * n + k] * B[k * n + j];
      C[i * n + j] = acc;
    }
}
