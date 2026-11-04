// Exact GELU used by Whisper (erf form, not the tanh approximation).
#include <cuda_runtime.h>

extern "C" __global__ void whisper_gelu_f32(float* __restrict__ x, int count) {
    const int index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= count) return;
    const float v = x[index];
    x[index] = 0.5f * v * (1.0f + erff(v * 0.70710678118654752440f));
}
