// Row-wise softmax. Optional causal masking is handled by the caller's scores.
#include <cuda_runtime.h>
#include <cfloat>

constexpr int THREADS = 256;

__device__ __forceinline__ float block_max(float value, float* shared) {
    shared[threadIdx.x] = value;
    __syncthreads();
    for (int step = THREADS / 2; step > 0; step >>= 1) {
        if (threadIdx.x < step) shared[threadIdx.x] = fmaxf(shared[threadIdx.x], shared[threadIdx.x + step]);
        __syncthreads();
    }
    return shared[0];
}

__device__ __forceinline__ float block_sum(float value, float* shared) {
    shared[threadIdx.x] = value;
    __syncthreads();
    for (int step = THREADS / 2; step > 0; step >>= 1) {
        if (threadIdx.x < step) shared[threadIdx.x] += shared[threadIdx.x + step];
        __syncthreads();
    }
    return shared[0];
}

extern "C" __global__ void whisper_softmax_f32(float* __restrict__ x, int rows, int cols) {
    __shared__ float scratch[THREADS];
    const int row = blockIdx.x;
    float* xr = x + (long long)row * cols;
    float local_max = -FLT_MAX;
    for (int i = threadIdx.x; i < cols; i += THREADS) local_max = fmaxf(local_max, xr[i]);
    const float maximum = block_max(local_max, scratch);
    float local_sum = 0.0f;
    for (int i = threadIdx.x; i < cols; i += THREADS) {
        const float v = expf(xr[i] - maximum);
        xr[i] = v;
        local_sum += v;
    }
    const float sum = block_sum(local_sum, scratch);
    const float inverse = 1.0f / sum;
    for (int i = threadIdx.x; i < cols; i += THREADS) xr[i] *= inverse;
}
