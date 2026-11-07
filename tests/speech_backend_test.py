"""Backend contract tests run on Windows; M1 hardware inference is not simulated."""
from pathlib import Path
import os
import sys
import types
import tempfile
import json
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/speech'))
import faster_backend as backend


class BackendContract(unittest.TestCase):
    def profile(self, system='darwin', machine='arm64'):
        build = 'win-amd64' if system == 'win32' and machine == 'AMD64' else 'other'
        with patch.object(sys, 'platform', system), patch.object(backend.platform, 'machine', return_value=machine), \
                patch.object(backend.sysconfig, 'get_platform', return_value=build):
            return backend.profile()

    @unittest.skipUnless(sys.platform == 'win32', 'Real Windows interpreter regression')
    def test_windows_architecture_with_the_sanitized_worker_environment(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(backend.profile()['architecture'], 'x64')

    def test_native_profiles_and_rosetta_rejection(self):
        self.assertEqual(self.profile()['device'], 'cpu')
        self.assertEqual(self.profile('win32', 'AMD64')['computeType'], 'float16')
        with self.assertRaises(RuntimeError):
            self.profile('darwin', 'x86_64')

    def configure(self, selected, supported=None, backend_version='4.8.5', **extra):
        model = types.SimpleNamespace(model=types.SimpleNamespace(is_multilingual=True))
        constructor = Mock(return_value=model)
        ct2 = types.SimpleNamespace(__version__=backend_version, get_supported_compute_types=Mock(return_value=supported or {'int8', 'float16'}))
        modules = {'ctranslate2': ct2, 'faster_whisper': types.SimpleNamespace(WhisperModel=constructor),
                   'faster_whisper.vad': types.SimpleNamespace(get_vad_model=Mock())}
        with patch.object(backend, 'profile', return_value=selected), patch.dict(sys.modules, modules), \
                patch.object(backend, 'model_directory', return_value=Path('/local-medium')):
            result = backend.configure({**selected, 'modelDirectory': '/local-medium', **extra})
        return result, constructor, ct2

    def test_m1_constructs_cpu_int8_with_local_files_only(self):
        selected = self.profile()
        (model, status), constructor, ct2 = self.configure(selected)
        options = constructor.call_args.kwargs
        self.assertEqual(options['device'], 'cpu')
        self.assertEqual(options['compute_type'], 'int8')
        self.assertEqual(options['cpu_threads'], 4)
        self.assertTrue(options['local_files_only'])
        ct2.get_supported_compute_types.assert_called_once_with('cpu')
        self.assertEqual(status['protocolVersion'], 1)
        self.assertEqual(status['architecture'], 'arm64')
        self.assertIsNotNone(model)

    def test_windows_still_constructs_cuda_fp16(self):
        (_, status), constructor, ct2 = self.configure(self.profile('win32', 'AMD64'))
        self.assertEqual(constructor.call_args.kwargs['device'], 'cuda')
        self.assertEqual(status['computeType'], 'float16')
        ct2.get_supported_compute_types.assert_called_once_with('cuda')

    def test_mixed_int8_float16_profile_remains_cuda_and_is_passed_to_the_model(self):
        with patch.dict(os.environ, {'NOTION_SWITCH_SPEECH_COMPUTE_TYPE': 'int8_float16'}, clear=True):
            selected = self.profile('win32', 'AMD64')
        self.assertEqual(selected['device'], 'cuda')
        self.assertEqual(selected['computeType'], 'int8_float16')
        (_, status), constructor, ct2 = self.configure(selected, supported={'float16', 'int8_float16'})
        self.assertEqual(status['device'], 'cuda')
        self.assertEqual(constructor.call_args.kwargs['device'], 'cuda')
        self.assertEqual(constructor.call_args.kwargs['compute_type'], 'int8_float16')
        ct2.get_supported_compute_types.assert_called_once_with('cuda')

    def test_mixed_gpu_precision_does_not_change_cpu_int8(self):
        with patch.dict(os.environ, {'NOTION_SWITCH_SPEECH_DEVICE': 'cpu', 'NOTION_SWITCH_SPEECH_COMPUTE_TYPE': 'int8_float16'}, clear=True):
            self.assertEqual(self.profile('win32', 'AMD64')['device'], 'cpu')
            self.assertEqual(self.profile('win32', 'AMD64')['computeType'], 'int8')
            self.assertEqual(self.profile()['device'], 'cpu')
            self.assertEqual(self.profile()['computeType'], 'int8')

    def test_unsupported_mixed_gpu_precision_fails_before_model_load(self):
        selected = {**self.profile('win32', 'AMD64'), 'computeType': 'int8_float16'}
        constructor = Mock()
        ct2 = types.SimpleNamespace(__version__='4.8.5', get_supported_compute_types=Mock(return_value={'float16'}))
        with patch.object(backend, 'profile', return_value=selected), patch.object(backend, 'model_directory', return_value=Path('/local-medium')), \
                patch.dict(sys.modules, {'ctranslate2': ct2, 'faster_whisper': types.SimpleNamespace(WhisperModel=constructor)}):
            with self.assertRaisesRegex(RuntimeError, 'compute backend unavailable'):
                backend.configure({**selected, 'modelDirectory': '/local-medium'})
        constructor.assert_not_called()

    def test_windows_rejects_gpu_backends_without_the_validated_fp16_fixes(self):
        for version in ['4.8.1', '4.8.3', '4.8.4']:
            with self.subTest(version=version), self.assertRaisesRegex(RuntimeError, '4.8.5'):
                self.configure(self.profile('win32', 'AMD64'), backend_version=version)

    def test_copied_dll_or_cuda_configuration_cannot_run_on_m1(self):
        for extra in ({'dllDirectory': 'C:\\cuda'}, {'device': 'cuda'}, {'architecture': 'x64'}):
            with self.subTest(extra=extra), self.assertRaises(RuntimeError):
                self.configure(self.profile(), **extra)

    def test_missing_compute_capability_does_not_silently_switch_backend(self):
        with self.assertRaises(RuntimeError):
            self.configure(self.profile(), supported={'float32'})

    def test_private_variant_is_selected_before_the_installed_package(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / 'ctranslate2'
            package.mkdir()
            (package / '__init__.py').write_text('')
            with patch.dict(os.environ, {'NOTION_SWITCH_CT2_MODULE_PATH': str(root)}), \
                    patch.object(sys, 'path', list(sys.path)), patch.dict(sys.modules):
                sys.modules.pop('ctranslate2', None)
                selected = backend.prepare_module_path()
                self.assertEqual(selected, root.resolve())
                self.assertEqual(Path(sys.path[0]), root.resolve())

    def test_relative_or_missing_private_variant_cannot_silently_use_the_default(self):
        for directory in ['relative-variant', str(Path(tempfile.gettempdir()) / 'missing-ct2-variant')]:
            with patch.dict(os.environ, {'NOTION_SWITCH_CT2_MODULE_PATH': directory}), self.assertRaises(RuntimeError):
                backend.prepare_module_path()

    def test_preload_uses_each_absolute_dll_path_in_dependency_order(self):
        names = ['cudart64_12.dll', 'cublasLt64_12.dll', 'cublas64_12.dll', 'cudnn64_9.dll']
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in names:
                (root / name).write_bytes(b'fixture')
            with patch.object(backend.ctypes, 'WinDLL', create=True) as load:
                backend.preload_cuda_libraries([root])
            self.assertEqual([Path(call.args[0]).name for call in load.call_args_list], names)
            self.assertTrue(all(Path(call.args[0]).is_absolute() for call in load.call_args_list))

    def test_incomplete_preload_fails_before_loading_any_gpu_library(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(backend.ctypes, 'WinDLL', create=True) as load:
            (Path(directory) / 'cudnn64_9.dll').write_bytes(b'fixture')
            with self.assertRaisesRegex(RuntimeError, 'complete'):
                backend.preload_cuda_libraries([Path(directory)])
            load.assert_not_called()

    def test_native_variant_can_select_cuda13_without_a_cudnn_dependency(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            libraries = ['cudart64_13.dll', 'cublasLt64_13.dll', 'cublas64_13.dll']
            (root / 'variant.json').write_text(json.dumps({'version': 1, 'dllDirectories': ['gpu-libs'], 'preloadLibraries': libraries}))
            paths, names = backend.variant_library_paths(root)
            self.assertEqual(paths, [str((root / 'gpu-libs').resolve())])
            self.assertEqual(names, libraries)

    def test_invalid_variant_manifest_is_not_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'variant.json').write_text(json.dumps({'version': 1, 'dllDirectories': ['gpu-libs'], 'preloadLibraries': ['../foreign.dll']}))
            with self.assertRaisesRegex(RuntimeError, 'manifest'):
                backend.variant_library_paths(root)

    def memory_fixture(self, return_code=0):
        def read(free, total):
            free._obj.value = 10 * 1024**3
            total._obj.value = 16 * 1024**3
            return return_code
        function = Mock(side_effect=read)
        library = types.SimpleNamespace(cudaMemGetInfo=function)
        path = str(Path(tempfile.gettempdir()) / 'cudart64_13.dll')
        return path, function, library

    def test_cuda_memory_query_is_disabled_by_default_and_never_queries_cpu(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(backend, 'loaded_library_audit') as audit:
            self.assertIsNone(backend.cuda_memory_info({'device': 'cuda'}))
            audit.assert_not_called()
        with patch.dict(os.environ, {'NOTION_SWITCH_SPEECH_CUDA_MEMINFO': '1'}, clear=True), \
                patch.object(backend, 'loaded_library_audit') as audit:
            self.assertIsNone(backend.cuda_memory_info(None))
            self.assertIsNone(backend.cuda_memory_info({'device': 'cpu'}))
            audit.assert_not_called()

    def test_cuda_memory_query_uses_only_the_loaded_runtime_and_caches_the_binding(self):
        path, function, library = self.memory_fixture()
        with patch.dict(os.environ, {'NOTION_SWITCH_SPEECH_CUDA_MEMINFO': '1'}, clear=True), \
                patch.object(backend, 'loaded_library_audit', return_value={'libraries': [{'name': 'cudart64_13.dll', 'path': path}]}), \
                patch.object(backend.ctypes, 'WinDLL', create=True, return_value=library) as load, \
                patch.object(backend, 'CUDA_MEMINFO_FUNCTIONS', {}):
            result = backend.cuda_memory_info({'device': 'cuda'})
            again = backend.cuda_memory_info({'device': 'cuda'})
        self.assertEqual(result['freeBytes'], 10 * 1024**3)
        self.assertEqual(result['totalBytes'], 16 * 1024**3)
        self.assertEqual(result['returnCode'], 0)
        self.assertEqual(result['runtimePath'], path)
        self.assertEqual(again['returnCode'], 0)
        load.assert_called_once_with(path)
        self.assertEqual(function.call_count, 2)

    def test_cuda_memory_query_preserves_runtime_failure_code_and_nulls_unknown_values(self):
        path, function, library = self.memory_fixture(return_code=700)
        with patch.dict(os.environ, {'NOTION_SWITCH_SPEECH_CUDA_MEMINFO': '1'}, clear=True), \
                patch.object(backend, 'loaded_library_audit', return_value={'libraries': [{'name': 'cudart64_13.dll', 'path': path}]}), \
                patch.object(backend.ctypes, 'WinDLL', create=True, return_value=library), patch.object(backend, 'CUDA_MEMINFO_FUNCTIONS', {}):
            result = backend.cuda_memory_info({'device': 'cuda'})
        self.assertEqual(result['returnCode'], 700)
        self.assertIsNone(result['freeBytes'])
        self.assertIsNone(result['totalBytes'])

    def test_cuda_memory_query_does_not_guess_between_two_loaded_runtimes(self):
        with patch.dict(os.environ, {'NOTION_SWITCH_SPEECH_CUDA_MEMINFO': '1'}, clear=True), \
                patch.object(backend, 'loaded_library_audit', return_value={'libraries': [
                    {'name': 'cudart64_12.dll', 'path': str(Path(tempfile.gettempdir()) / 'cudart64_12.dll')},
                    {'name': 'cudart64_13.dll', 'path': str(Path(tempfile.gettempdir()) / 'cudart64_13.dll')}]}), \
                patch.object(backend.ctypes, 'WinDLL', create=True) as load:
            result = backend.cuda_memory_info({'device': 'cuda'})
        self.assertEqual(result['diagnosticCode'], 'AMBIGUOUS_CUDART')
        self.assertIsNone(result['returnCode'])
        self.assertIsNone(result['freeBytes'])
        load.assert_not_called()

    def test_cuda_memory_diagnostic_failure_does_not_throw_into_the_decoder(self):
        with patch.dict(os.environ, {'NOTION_SWITCH_SPEECH_CUDA_MEMINFO': '1'}, clear=True), \
                patch.object(backend, 'loaded_library_audit', side_effect=OSError('audit fixture')):
            result = backend.cuda_memory_info({'device': 'cuda'})
        self.assertEqual(result['diagnosticCode'], 'QUERY_EXCEPTION')
        self.assertIsNone(result['freeBytes'])


if __name__ == '__main__':
    unittest.main()
