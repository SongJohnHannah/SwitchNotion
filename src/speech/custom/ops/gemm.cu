// Tiled FP32 GEMM: C[M,N] = A[M,K] * B[N,K]^T + bias.
#include <cuda_runtime.h>

constexpr int BM = 64;
constexpr int BN = 64;
constexpr int BK = 16;
constexpr int TM = 4;
constexpr int TN = 4;
constexpr int THREADS = 256;

extern "C" __global__ void whisper_linear_f32_tiled(
    const float* __restrict__ a, const float* __restrict__ b, const float* __restrict__ bias,
    float* __restrict__ c, int rows, int outputs, int inputs) {
    __shared__ float shared_a[BM][BK];
    __shared__ float shared_b[BN][BK];
    const int tx = threadIdx.x & 15;
    const int ty = threadIdx.x >> 4;
    const int row_base = blockIdx.y * BM;
    const int column_base = blockIdx.x * BN;
    float accumulators[TM][TN] = {};

    for (int k_base = 0; k_base < inputs; k_base += BK) {
        for (int index = threadIdx.x; index < BM * BK; index += THREADS) {
            const int row = index / BK, column = index % BK;
            const int global_row = row_base + row, global_k = k_base + column;
            shared_a[row][column] = global_row < rows && global_k < inputs
                ? a[(long long)global_row * inputs + global_k] : 0.0f;
        }
        for (int index = threadIdx.x; index < BN * BK; index += THREADS) {
            const int row = index / BK, column = index % BK;
            const int global_row = column_base + row, global_k = k_base + column;
            shared_b[row][column] = global_row < outputs && global_k < inputs
                ? b[(long long)global_row * inputs + global_k] : 0.0f;
        }
        __syncthreads();
        #pragma unroll
        for (int k = 0; k < BK; k++) {
            float left[TM], right[TN];
            #pragma unroll
            for (int r = 0; r < TM; r++) left[r] = shared_a[ty * TM + r][k];
            #pragma unroll
            for (int n = 0; n < TN; n++) right[n] = shared_b[tx * TN + n][k];
            #pragma unroll
            for (int r = 0; r < TM; r++)
                #pragma unroll
                for (int n = 0; n < TN; n++) accumulators[r][n] = fmaf(left[r], right[n], accumulators[r][n]);
        }
        __syncthreads();
    }

    #pragma unroll
    for (int r = 0; r < TM; r++) {
        #pragma unroll
        for (int n = 0; n < TN; n++) {
            const int global_row = row_base + ty * TM + r;
            const int global_column = column_base + tx * TN + n;
            if (global_row < rows && global_column < outputs) {
                c[(long long)global_row * outputs + global_column] =
                    accumulators[r][n] + (bias ? bias[global_column] : 0.0f);
            }
        }
    }
}
