// Throughput-oriented baseline kernels: one thread per output element.
#include <cuda_runtime.h>

extern "C" __global__ void whisper_linear_f32_simple(
    const float* __restrict__ x, const float* __restrict__ w, const float* __restrict__ bias,
    float* __restrict__ y, int rows, int outputs, int inputs) {
    const long long index = (long long)blockIdx.x * blockDim.x + threadIdx.x;
    const long long total = (long long)rows * outputs;
    if (index >= total) return;
    const int row = index / outputs;
    const int column = index - (long long)row * outputs;
    const float* xr = x + (long long)row * inputs;
    const float* wr = w + (long long)column * inputs;
    float acc = bias ? bias[column] : 0.0f;
    for (int k = 0; k < inputs; k++) acc = fmaf(xr[k], wr[k], acc);
    y[index] = acc;
}

extern "C" __global__ void whisper_conv1d_k3_f32_simple(
    const float* __restrict__ x, const float* __restrict__ weight, const float* __restrict__ bias,
    float* __restrict__ y, int length, int out_length, int in_channels, int out_channels,
    int stride, int padding) {
    const long long index = (long long)blockIdx.x * blockDim.x + threadIdx.x;
    const long long total = (long long)out_channels * out_length;
    if (index >= total) return;
    const int channel = index / out_length;
    const int position = index - (long long)channel * out_length;
    float acc = bias ? bias[channel] : 0.0f;
    for (int input_channel = 0; input_channel < in_channels; input_channel++) {
        const float* row = x + (long long)input_channel * length;
        const float* kernel = weight + ((long long)channel * in_channels + input_channel) * 3;
        for (int tap = 0; tap < 3; tap++) {
            const int source = position * stride - padding + tap;
            if (source >= 0 && source < length) acc = fmaf(row[source], kernel[tap], acc);
        }
    }
    y[index] = acc;
}
