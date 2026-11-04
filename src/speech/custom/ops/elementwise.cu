// Small elementwise/layout kernels needed by the Whisper encoder/decoder.
#include <cuda_runtime.h>
#include <cfloat>

extern "C" __global__ void whisper_add_f32(float* __restrict__ a, const float* __restrict__ b, int count) {
    const int index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < count) a[index] += b[index];
}

extern "C" __global__ void whisper_scale_add_f32(float* __restrict__ a, const float* __restrict__ b, float scale, int count) {
    const int index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < count) a[index] = a[index] * scale + b[index];
}

extern "C" __global__ void whisper_embedding_f32(
    const int* __restrict__ tokens, const float* __restrict__ table, float* __restrict__ out,
    int count, int dimension) {
    const int index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= count * dimension) return;
    const int token = index / dimension;
    const int offset = index - token * dimension;
    out[index] = table[(long long)tokens[token] * dimension + offset];
}

extern "C" __global__ void whisper_transpose_heads_f32(
    const float* __restrict__ src, float* __restrict__ dst, int length, int heads, int dimension) {
    const int index = blockIdx.x * blockDim.x + threadIdx.x;
    const int total = length * heads * dimension;
    if (index >= total) return;
    const int position = index / (heads * dimension);
    const int rest = index - position * heads * dimension;
    const int head = rest / dimension;
    const int offset = rest - head * dimension;
    dst[((long long)head * length + position) * dimension + offset] = src[index];
}

extern "C" __global__ void whisper_merge_heads_f32(
    const float* __restrict__ src, float* __restrict__ dst, int length, int heads, int dimension) {
    const int index = blockIdx.x * blockDim.x + threadIdx.x;
    const int total = length * heads * dimension;
    if (index >= total) return;
    const int position = index / (heads * dimension);
    const int rest = index - position * heads * dimension;
    const int head = rest / dimension;
    const int offset = rest - head * dimension;
    dst[index] = src[((long long)head * length + position) * dimension + offset];
}

extern "C" __global__ void whisper_transpose_2d_f32(
    const float* __restrict__ src, float* __restrict__ dst, int rows, int cols) {
    const int index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= rows * cols) return;
    const int row = index / cols;
    const int column = index - row * cols;
    dst[column * rows + row] = src[index];
}

extern "C" __global__ void whisper_argmax_f32(const float* __restrict__ logits, int count, int* __restrict__ out) {
    __shared__ float values[256];
    __shared__ int indices[256];
    float best = -FLT_MAX;
    int best_index = 0;
    for (int i = threadIdx.x; i < count; i += blockDim.x) {
        const float value = logits[i];
        if (value > best) { best = value; best_index = i; }
    }
    values[threadIdx.x] = best;
    indices[threadIdx.x] = best_index;
    __syncthreads();
    for (int step = blockDim.x / 2; step > 0; step >>= 1) {
        if (threadIdx.x < step && values[threadIdx.x + step] > values[threadIdx.x]) {
            values[threadIdx.x] = values[threadIdx.x + step];
            indices[threadIdx.x] = indices[threadIdx.x + step];
        }
        __syncthreads();
    }
    if (threadIdx.x == 0) out[0] = indices[0];
}
