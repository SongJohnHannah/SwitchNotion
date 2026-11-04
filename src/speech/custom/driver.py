"""Standalone CUDA Driver API loader for the custom Whisper operators.

No PyTorch/CTranslate2 dependency. The worker owns its own CUDA context so the
cubin kernels can run from the plain Python speech worker.
"""
import ctypes
import sys
from pathlib import Path

if sys.platform != 'win32':
    raise ImportError('CUDA Driver API operators are Windows-only')


class CudaError(RuntimeError):
    pass


class CudaDriver:
    def __init__(self, device=0):
        self.lib = ctypes.WinDLL('nvcuda.dll')
        d = self.lib
        d.cuInit.argtypes = [ctypes.c_uint]
        d.cuInit.restype = ctypes.c_int
        d.cuDeviceGet.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_int]
        d.cuDeviceGet.restype = ctypes.c_int
        d.cuCtxGetCurrent.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
        d.cuCtxGetCurrent.restype = ctypes.c_int
        d.cuDevicePrimaryCtxRetain.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_int]
        d.cuDevicePrimaryCtxRetain.restype = ctypes.c_int
        d.cuCtxSetCurrent.argtypes = [ctypes.c_void_p]
        d.cuCtxSetCurrent.restype = ctypes.c_int
        d.cuCtxSynchronize.argtypes = []
        d.cuCtxSynchronize.restype = ctypes.c_int
        d.cuModuleLoadData.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
        d.cuModuleLoadData.restype = ctypes.c_int
        d.cuModuleGetFunction.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p, ctypes.c_char_p]
        d.cuModuleGetFunction.restype = ctypes.c_int
        d.cuModuleUnload.argtypes = [ctypes.c_void_p]
        d.cuModuleUnload.restype = ctypes.c_int
        d.cuMemAlloc_v2.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_size_t]
        d.cuMemAlloc_v2.restype = ctypes.c_int
        d.cuMemFree_v2.argtypes = [ctypes.c_void_p]
        d.cuMemFree_v2.restype = ctypes.c_int
        d.cuMemcpyHtoD_v2.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
        d.cuMemcpyHtoD_v2.restype = ctypes.c_int
        d.cuMemcpyDtoH_v2.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
        d.cuMemcpyDtoH_v2.restype = ctypes.c_int
        d.cuLaunchKernel.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint,
                                     ctypes.c_uint, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint,
                                     ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
        d.cuLaunchKernel.restype = ctypes.c_int
        d.cuGetErrorName.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_char_p)]
        d.cuGetErrorName.restype = ctypes.c_int
        self._check(d.cuInit(0), 'cuInit')
        self.device = ctypes.c_int()
        self._check(d.cuDeviceGet(ctypes.byref(self.device), device), 'cuDeviceGet')
        current = ctypes.c_void_p()
        self._check(d.cuCtxGetCurrent(ctypes.byref(current)), 'cuCtxGetCurrent')
        if current.value:
            self.context = current
        else:
            self.context = ctypes.c_void_p()
            self._check(d.cuDevicePrimaryCtxRetain(ctypes.byref(self.context), self.device), 'cuDevicePrimaryCtxRetain')
            self._check(d.cuCtxSetCurrent(self.context), 'cuCtxSetCurrent')
        self.modules = {}

    def _check(self, code, name):
        if code:
            err = ctypes.c_char_p()
            self.lib.cuGetErrorName(code, ctypes.byref(err))
            detail = err.value.decode('ascii', 'replace') if err.value else str(code)
            raise CudaError(f'{name} failed: {detail} ({code})')

    def load(self, cubin_path):
        path = Path(cubin_path)
        if path in self.modules:
            return self.modules[path]
        image = ctypes.create_string_buffer(path.read_bytes())
        module = ctypes.c_void_p()
        self._check(self.lib.cuModuleLoadData(ctypes.byref(module), ctypes.cast(image, ctypes.c_void_p)),
                    f'cuModuleLoadData({path.name})')
        self.modules[path] = (module, image)
        return self.modules[path]

    def function(self, cubin_path, name):
        module, _ = self.load(cubin_path)
        fn = ctypes.c_void_p()
        self._check(self.lib.cuModuleGetFunction(ctypes.byref(fn), module, name.encode()), f'cuModuleGetFunction({name})')
        return fn

    def malloc(self, nbytes):
        if nbytes <= 0:
            raise ValueError('Device allocation must be positive')
        ptr = ctypes.c_void_p()
        self._check(self.lib.cuMemAlloc_v2(ctypes.byref(ptr), ctypes.c_size_t(nbytes)), 'cuMemAlloc')
        return ptr

    def free(self, ptr):
        if ptr:
            self._check(self.lib.cuMemFree_v2(ptr), 'cuMemFree')

    def h2d(self, dst, data):
        buf = ctypes.create_string_buffer(bytes(data), len(data))
        self._check(self.lib.cuMemcpyHtoD_v2(dst, ctypes.cast(buf, ctypes.c_void_p), ctypes.c_size_t(len(data))), 'cuMemcpyHtoD')
        return buf

    def d2h(self, src, nbytes):
        buf = ctypes.create_string_buffer(nbytes)
        self._check(self.lib.cuMemcpyDtoH_v2(ctypes.cast(buf, ctypes.c_void_p), src, ctypes.c_size_t(nbytes)), 'cuMemcpyDtoH')
        return buf

    def launch(self, fn, grid, block, args, shared=0):
        values = []
        pointers = []
        for arg in args:
            if isinstance(arg, ctypes._SimpleCData):
                values.append(arg)
            elif isinstance(arg, int):
                values.append(ctypes.c_int64(arg))
            else:
                raise TypeError(f'Unsupported kernel argument {type(arg)!r}')
        for value in values:
            pointers.append(ctypes.cast(ctypes.byref(value), ctypes.c_void_p))
        params = (ctypes.c_void_p * len(pointers))(*pointers)
        gx, gy, gz = grid
        bx, by, bz = block
        self._check(self.lib.cuLaunchKernel(fn, gx, gy, gz, bx, by, bz, shared, None, params, None),
                    'cuLaunchKernel')
        self._check(self.lib.cuCtxSynchronize(), 'cuCtxSynchronize')

    def close(self):
        for module, _ in self.modules.values():
            self.lib.cuModuleUnload(module)
        self.modules.clear()
