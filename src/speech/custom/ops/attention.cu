// Scaled dot-product attention for Whisper heads (head_dim 64 by default).
// Layout: q/k/v/out are [heads, sequence, head_dim].
#include <cuda_runtime.h>
#include <cfloat>

constexpr int THREADS = 128;
constexpr int MAX_KEYS = 4096;

extern "C" __global__ void whisper_attention_f32(
    const float* __restrict__ q, const float* __restrict__ k, const float* __restrict__ v,
    float* __restrict__ out, int query_length, int key_length, int heads, int head_dim,
    int causal, float scale) {
    extern __shared__ float scores[];
    __shared__ float scratch[THREADS];
    const int head = blockIdx.x;
    const int query = blockIdx.y;
    if (key_length > MAX_KEYS) return;
    const float* qh = q + ((long long)head * query_length + query) * head_dim;
    const float* kh = k + (long long)head * key_length * head_dim;
    const float* vh = v + (long long)head * key_length * head_dim;
    float* oh = out + ((long long)head * query_length + query) * head_dim;

    float local_max = -FLT_MAX;
    for (int key = threadIdx.x; key < key_length; key += THREADS) {
        float dot = 0.0f;
        if (!causal || key <= query) {
            const float* kr = kh + (long long)key * head_dim;
            for (int d = 0; d < head_dim; d++) dot = fmaf(qh[d], kr[d], dot);
            dot *= scale;
        } else {
            dot = -FLT_MAX;
        }
        scores[key] = dot;
        local_max = fmaxf(local_max, dot);
    }
    scratch[threadIdx.x] = local_max;
    __syncthreads();
    for (int step = THREADS / 2; step > 0; step >>= 1) {
        if (threadIdx.x < step) scratch[threadIdx.x] = fmaxf(scratch[threadIdx.x], scratch[threadIdx.x + step]);
        __syncthreads();
    }
    const float maximum = scratch[0];

    float local_sum = 0.0f;
    for (int key = threadIdx.x; key < key_length; key += THREADS) {
        const float value = scores[key] == -FLT_MAX ? 0.0f : expf(scores[key] - maximum);
        scores[key] = value;
        local_sum += value;
    }
    scratch[threadIdx.x] = local_sum;
    __syncthreads();
    for (int step = THREADS / 2; step > 0; step >>= 1) {
        if (threadIdx.x < step) scratch[threadIdx.x] += scratch[threadIdx.x + step];
        __syncthreads();
    }
    const float inverse = 1.0f / scratch[0];

    for (int d = threadIdx.x; d < head_dim; d += THREADS) {
        float acc = 0.0f;
        for (int key = 0; key < key_length; key++) {
            acc = fmaf(scores[key] * inverse, vh[(long long)key * head_dim + d], acc);
        }
        oh[d] = acc;
    }
}
