// Whisper convolutional stem: 1-D convolution with kernel width 3.
#include <cuda_runtime.h>

constexpr int THREADS = 128;

extern "C" __global__ void whisper_conv1d_k3_f32(
    const float* __restrict__ x, const float* __restrict__ weight, const float* __restrict__ bias,
    float* __restrict__ y, int length, int out_length, int in_channels, int out_channels,
    int stride, int padding) {
    __shared__ float partial[THREADS];
    const int item = blockIdx.x;
    const int channel = item / out_length;
    const int position = item - channel * out_length;
    float acc = 0.0f;
    const int taps = in_channels * 3;
    for (int index = threadIdx.x; index < taps; index += THREADS) {
        const int input_channel = index / 3;
        const int tap = index - input_channel * 3;
        const int source = position * stride - padding + tap;
        if (source >= 0 && source < length) {
            acc = fmaf(x[(long long)input_channel * length + source],
                       weight[((long long)channel * in_channels + input_channel) * 3 + tap], acc);
        }
    }
    partial[threadIdx.x] = acc;
    __syncthreads();
    for (int step = THREADS / 2; step > 0; step >>= 1) {
        if (threadIdx.x < step) partial[threadIdx.x] += partial[threadIdx.x + step];
        __syncthreads();
    }
    if (threadIdx.x == 0) y[(long long)channel * out_length + position] = partial[0] + (bias ? bias[channel] : 0.0f);
}
