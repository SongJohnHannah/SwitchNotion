// Whisper LayerNorm. One block per row; FP32 accumulation.
#include <cuda_runtime.h>

constexpr int THREADS = 256;

extern "C" __global__ void whisper_layer_norm_f32(
    const float* __restrict__ x, const float* __restrict__ weight, const float* __restrict__ bias,
    float* __restrict__ y, int rows, int cols, float eps) {
    __shared__ float reduce_sum[THREADS];
    __shared__ float reduce_square[THREADS];
    const int row = blockIdx.x;
    const float* xr = x + (long long)row * cols;
    float* yr = y + (long long)row * cols;
    float sum = 0.0f, square = 0.0f;
    for (int i = threadIdx.x; i < cols; i += THREADS) {
        const float v = xr[i];
        sum += v;
        square += v * v;
    }
    reduce_sum[threadIdx.x] = sum;
    reduce_square[threadIdx.x] = square;
    __syncthreads();
    for (int step = THREADS / 2; step > 0; step >>= 1) {
        if (threadIdx.x < step) {
            reduce_sum[threadIdx.x] += reduce_sum[threadIdx.x + step];
            reduce_square[threadIdx.x] += reduce_square[threadIdx.x + step];
        }
        __syncthreads();
    }
    const float mean = reduce_sum[0] / cols;
    const float variance = fmaxf(reduce_square[0] / cols - mean * mean, 0.0f);
    const float inverse = rsqrtf(variance + eps);
    for (int i = threadIdx.x; i < cols; i += THREADS) {
        yr[i] = (xr[i] - mean) * inverse * weight[i] + bias[i];
    }
}
