"""Backend contract tests run on Windows; M1 hardware inference is not simulated."""
from pathlib import Path
import os
import sys
import types
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

    def configure(self, selected, supported=None, **extra):
        model = types.SimpleNamespace(model=types.SimpleNamespace(is_multilingual=True))
        constructor = Mock(return_value=model)
        ct2 = types.SimpleNamespace(get_supported_compute_types=Mock(return_value=supported or {'int8', 'float16'}))
        modules = {'ctranslate2': ct2, 'faster_whisper': types.SimpleNamespace(WhisperModel=constructor)}
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

    def test_copied_dll_or_cuda_configuration_cannot_run_on_m1(self):
        for extra in ({'dllDirectory': 'C:\\cuda'}, {'device': 'cuda'}, {'architecture': 'x64'}):
            with self.subTest(extra=extra), self.assertRaises(RuntimeError):
                self.configure(self.profile(), **extra)

    def test_missing_compute_capability_does_not_silently_switch_backend(self):
        with self.assertRaises(RuntimeError):
            self.configure(self.profile(), supported={'float32'})


if __name__ == '__main__':
    unittest.main()
