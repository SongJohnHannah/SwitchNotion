// Whisper linear/GEMM operators. Correctness-first FP32 and FP16 variants.
#include <cuda_runtime.h>
#include <cuda_fp16.h>

constexpr int THREADS = 128;

__device__ __forceinline__ float block_sum(float value, float* shared) {
    shared[threadIdx.x] = value;
    __syncthreads();
    for (int step = THREADS / 2; step > 0; step >>= 1) {
        if (threadIdx.x < step) shared[threadIdx.x] += shared[threadIdx.x + step];
        __syncthreads();
    }
    return shared[0];
}

extern "C" __global__ void whisper_linear_f32(
    const float* __restrict__ x, const float* __restrict__ w, const float* __restrict__ bias,
    float* __restrict__ y, int rows, int outputs, int inputs) {
    __shared__ float partial[THREADS];
    const int item = blockIdx.x;
    const int row = item / outputs;
    const int column = item - row * outputs;
    if (row >= rows) return;
    const float* xr = x + (long long)row * inputs;
    const float* wr = w + (long long)column * inputs;
    float acc = 0.0f;
    for (int k = threadIdx.x; k < inputs; k += THREADS) acc = fmaf(xr[k], wr[k], acc);
    acc = block_sum(acc, partial);
    if (threadIdx.x == 0) y[item] = acc + (bias ? bias[column] : 0.0f);
}

extern "C" __global__ void whisper_linear_f16(
    const __half* __restrict__ x, const __half* __restrict__ w, const __half* __restrict__ bias,
    __half* __restrict__ y, int rows, int outputs, int inputs) {
    __shared__ float partial[THREADS];
    const int item = blockIdx.x;
    const int row = item / outputs;
    const int column = item - row * outputs;
    if (row >= rows) return;
    const __half* xr = x + (long long)row * inputs;
    const __half* wr = w + (long long)column * inputs;
    float acc = 0.0f;
    for (int k = threadIdx.x; k < inputs; k += THREADS) acc = fmaf(__half2float(xr[k]), __half2float(wr[k]), acc);
    acc = block_sum(acc, partial);
    if (threadIdx.x == 0) y[item] = __float2half(acc + (bias ? __half2float(bias[column]) : 0.0f));
}
