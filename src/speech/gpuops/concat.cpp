#include <pybind11/pybind11.h>
#include <pybind11/stl.h>
#include <ctranslate2/devices.h>
#include <ctranslate2/storage_view.h>
#include <ctranslate2/ops/concat.h>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <vector>

namespace py = pybind11;
using namespace pybind11::literals;
using namespace ctranslate2;
static constexpr uint64_t MAX_BUDGET = 64ull * 1024 * 1024;
static uint64_t cub_bin_bytes(uint64_t bytes) {
  uint64_t bin = 64; // Native variant: CUB growth=4, min_bin=3, max_bin=12.
  while (bin < bytes && bin < 16ull * 1024 * 1024) bin *= 4;
  return bin < bytes ? bytes : bin;
}

static StorageView concat_axis0(const py::sequence& objects, uint64_t max_bytes, dim_t input_mels) {
  if (objects.size() < 1 || objects.size() > 4 || max_bytes == 0 || max_bytes > MAX_BUDGET || input_mels < 1)
    throw std::invalid_argument("GPU concat accepts 1..4 encoded rows and at most 64MiB total bridge budget");
  std::vector<const StorageView*> inputs;
  py::list owners;
  uint64_t bytes = 0;
  int device_index = -1;
  Shape row_shape;
  for (const auto& object : objects) {
    owners.append(object); // Independent strong references survive GIL release/list mutation.
    // Cast a reference, never a by-value GPU copy; py::sequence retains owners.
    const auto& view = py::cast<const StorageView&>(object);
    if (view.device() != Device::CUDA)
      throw std::invalid_argument("GPU concat requires CUDA StorageView inputs");
    if (view.dtype() != DataType::FLOAT16 || view.rank() != 3 || view.dim(0) != 1 ||
        view.dim(1) <= 0 || view.dim(1) > 1500 || view.dim(2) != 1280 || view.dim(1) == input_mels)
      throw std::invalid_argument("GPU concat requires encoded FP16 [1,T,d_model], not mel features");
    if (inputs.empty()) { device_index = view.device_index(); row_shape = view.shape(); }
    else if (view.device_index() != device_index || view.shape() != row_shape)
      throw std::invalid_argument("GPU concat rows must have the same device, shape and dtype");
    const auto count = static_cast<uint64_t>(view.size());
    if (count > MAX_BUDGET / 2 || bytes > MAX_BUDGET - count * 2)
      throw std::invalid_argument("GPU concat byte count exceeds bounded memory budget");
    bytes += count * 2;
    inputs.push_back(&view);
  }
  // Reserve budget for all source rows + merged row + generate's sync_copy.
  if (bytes > max_bytes / 3)
    throw std::invalid_argument("GPU concat source/merged/generate copy exceeds bridge budget");
  const auto rounded_peak = inputs.size() * cub_bin_bytes(bytes / inputs.size()) + 2 * cub_bin_bytes(bytes);
  if (rounded_peak > max_bytes)
    throw std::invalid_argument("GPU concat CUB allocation bins exceed bridge budget");
  py::gil_scoped_release release;
  ScopedDeviceSetter device(Device::CUDA, device_index);
  StorageView output(DataType::FLOAT16, Device::CUDA);
  try {
    ops::Concat(0)(inputs, output);
    synchronize_stream(Device::CUDA);
  } catch (...) {
    // Inputs must outlive any copy already queued before propagating failure.
    // A sync failure still aborts this candidate; no context reset or fallback.
    try { synchronize_stream(Device::CUDA); } catch (...) {}
    throw;
  }
  return output;
}

PYBIND11_MODULE(_ct2_gpuops, module) {
  py::module_::import("ctranslate2"); // Register the original StorageView type first.
  module.def("concat_axis0", &concat_axis0, py::arg("views"), py::arg("max_bytes")=MAX_BUDGET,
             py::arg("input_mels")=128,
             "Use existing CT2 CUDA Concat axis0 and synchronize; never CPU-fallback.");
  module.def("cpu_abi_check", [](const StorageView& value) {
    if (value.device() != Device::CPU) throw std::invalid_argument("CPU ABI check accepts CPU storage only");
    return py::dict("shape"_a=value.shape(), "bytes"_a=value.size() * value.item_size());
  });
  module.attr("abi_contract") = "CT2-4.8.5/cp311/MSVC14.44; same native ctranslate2.dll; existing CT2 allocator/context/stream";
  module.attr("max_bridge_bytes") = MAX_BUDGET;
}
