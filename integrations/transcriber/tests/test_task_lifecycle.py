import copy
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import app as web
import core


class TaskLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.original_state = copy.deepcopy(core.state)
        self.temp = tempfile.TemporaryDirectory(prefix='.task-test-', dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state_file = self.root / 'state.json'
        for module in (core, web):
            patcher = patch.object(module, 'STATE_FILE', self.state_file)
            patcher.start()
            self.addCleanup(patcher.stop)
        core.state.update({
            'video_dir': str(self.root), 'output_dir': str(self.root),
            'transcribing': False, 'cancel_requested': False,
            'queue': [], 'done': [], 'errors': [],
            'current_index': 0, 'total': 0, 'current_video': '',
            'elapsed_per_video': [], 'add_ipa': False,
        })
        self.item = {'path': str(self.root / 'RLW3+Introduction+to+SRS.mp4'),
                     'name': 'RLW3+Introduction+to+SRS'}
        self.item_path = Path(self.item['path'])
        self.item_path.touch()
        self.worker_errors = []

    def tearDown(self):
        core.state.clear()
        core.state.update(self.original_state)

    def run_worker(self):
        try:
            core.worker()
        except Exception as error:
            self.worker_errors.append(error)

    def test_cancel_during_transcription_does_not_pop_empty_queue(self):
        entered = threading.Event()
        release = threading.Event()

        def transcribe(_path):
            entered.set()
            if not release.wait(3):
                raise RuntimeError('Test worker timed out')

        core.state.update(transcribing=True, queue=[self.item], total=1)
        with patch.object(core, 'transcribe_one', side_effect=transcribe):
            thread = threading.Thread(target=self.run_worker)
            thread.start()
            try:
                self.assertTrue(entered.wait(2))
                with web.app.test_client() as client:
                    response = client.post('/api/cancel')
                self.assertEqual(response.status_code, 200)
            finally:
                release.set()
                thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(self.worker_errors, [])
        self.assertFalse(core.state['transcribing'])

    def test_refresh_resume_cannot_transcribe_same_chunks_twice(self):
        core.state.update(queue=[self.item], total=1)
        core.save_state()
        entered = [threading.Event(), threading.Event()]
        release = [threading.Event(), threading.Event()]
        finished = [threading.Event(), threading.Event()]
        chunk_calls = []
        worker_calls = []
        threads = []
        calls_lock = threading.Lock()
        real_thread = threading.Thread

        def tracked_thread(*args, **kwargs):
            thread = real_thread(*args, **kwargs)
            threads.append(thread)
            return thread

        def tracked_worker():
            with calls_lock:
                index = len(worker_calls)
                worker_calls.append(index)
            try:
                self.run_worker()
            finally:
                finished[index].set()

        def chunk(_path, _output, **_kwargs):
            with calls_lock:
                call = len(chunk_calls)
                chunk_calls.append(call)
            entered[call].set()
            if not release[call].wait(3):
                raise RuntimeError('Test chunk timed out')
            return {'complete': True, 'device': 'cuda', 'text': 'Transcript',
                    'segments': [{'start': 0, 'end': 1, 'text': 'Transcript'}]}

        with (patch.object(web, 'worker', side_effect=tracked_worker),
              patch.object(web.threading, 'Thread', side_effect=tracked_thread),
              patch.object(core, 'OperatorBridge') as bridge):
            bridge.return_value.transcribe.side_effect = chunk
            try:
                with web.app.test_client() as client:
                    self.assertEqual(client.post('/api/resume').status_code, 200)
                    self.assertTrue(entered[0].wait(2))
                    # A refreshed or second browser tab posts resume while the first is busy.
                    client.post('/api/resume')
                entered[1].wait(0.2)
                release[0].set()
                self.assertTrue(finished[0].wait(2))
                release[1].set()
            finally:
                for event in release:
                    event.set()
                for thread in threads:
                    thread.join(3)
        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(core.state['errors'], [])
        self.assertEqual(self.worker_errors, [])
        self.assertEqual(len(chunk_calls), 1)
        self.assertEqual(len(core.state['done']), 1)
        self.assertEqual(self.item_path.with_suffix('.txt').read_text('utf-8'), 'Transcript')
        self.assertTrue(self.item_path.with_suffix('.srt').exists())

    def test_same_filename_succeeds_with_a_single_worker(self):
        core.state.update(transcribing=True, queue=[self.item], total=1)
        with patch.object(core, 'OperatorBridge') as bridge:
            bridge.return_value.transcribe.return_value = {
                'complete': True, 'device': 'cuda', 'text': 'Transcript', 'segments': []}
            self.run_worker()
        self.assertEqual(self.worker_errors, [])
        self.assertEqual(core.state['errors'], [])
        self.assertEqual(len(core.state['done']), 1)
        self.assertEqual(self.item_path.with_suffix('.txt').read_text('utf-8'), 'Transcript')

    def test_running_task_is_reported_instead_of_offering_resume(self):
        core.state.update(transcribing=True, queue=[self.item], total=1)
        core.save_state()
        with web.app.test_client() as client:
            response = client.get('/api/resume_check')
        self.assertTrue(response.json.get('running'))
        self.assertEqual(response.json['remaining'], 0)
        self.assertEqual(response.json['video_dir'], str(self.root))
        self.assertEqual(response.json['output_dir'], str(self.root))

    def test_cancel_keeps_task_busy_until_worker_exits(self):
        core.state.update(transcribing=True, queue=[self.item], total=1)
        core.save_state()
        with (patch.object(web, 'worker') as worker,
              web.app.test_client() as client):
            client.post('/api/cancel')
            self.assertTrue(core.state['transcribing'])
            self.assertEqual(client.post('/api/transcribe', json={'videos': [self.item]}).status_code, 409)
            self.assertEqual(client.post('/api/resume').json['status'], 'running')
            self.assertEqual(client.post('/api/resume_discard').status_code, 409)
            worker.assert_not_called()
        self.assertTrue(self.state_file.exists())

    def test_scan_does_not_change_running_task_source(self):
        core.state['transcribing'] = True
        with (patch.object(web, 'scan_media', return_value=[]),
              web.app.test_client() as client):
            client.post('/api/scan', json={'video_dir': str(self.root / 'other')})
        self.assertEqual(core.state['video_dir'], str(self.root))

    def test_scan_classifies_video_and_audio_extensions(self):
        (self.root / 'lesson.MP3').touch()
        (self.root / 'notes.txt').touch()
        items = {item['ext'].lower(): item for item in core.scan_media(str(self.root))}
        self.assertEqual(set(items), {'.mp3', '.mp4'})
        self.assertEqual(items['.mp3']['media_type'], 'audio')
        self.assertEqual(items['.mp4']['media_type'], 'video')


if __name__ == '__main__':
    unittest.main()
