import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('transcript_differences', Path(__file__).parents[1] / 'scripts/audit-transcript-differences.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class TranscriptDifferenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='transcript-differences-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def document(self, name, text, end=10, segments=None):
        directory = self.root / name
        directory.mkdir()
        checkpoint = {'totalSamples': 160000, 'parts': [{'index': 0, 'startSample': 0, 'samples': 160000,
                      'text': text, 'segments': segments if segments is not None else [{'start': 0, 'end': end, 'text': text}]}]}
        (directory / 'checkpoint.json').write_text(json.dumps(checkpoint), 'utf-8')
        (directory / 'transcript.txt').write_text(text, 'utf-8')
        return audit.load_document(directory)

    def test_equal_words_ignore_punctuation_case_and_do_not_claim_accuracy(self):
        report = audit.compare_documents(self.document('ref', 'Hello, WORLD!'), self.document('new', 'hello world.'))
        self.assertEqual(report['findingCount'], 0)
        self.assertEqual(report['status'], 'no-large-differences-found')
        self.assertNotIn('WER', report)

    def test_missing_clause_retains_original_segment_and_nearby_candidate_evidence(self):
        report = audit.compare_documents(self.document('ref', 'Opening. Let us be honest I agree with you. Closing.'),
                                         self.document('new', 'Opening. Closing.'))
        self.assertEqual(report['status'], 'content-review')
        self.assertEqual(report['findings'][0]['reviewReason'], 'possible-omitted-clause')
        self.assertIn('Let us be honest', report['findings'][0]['referenceSegments'][0]['text'])
        self.assertEqual(report['findings'][0]['referenceSegments'][0]['start'], 0)
        self.assertEqual(report['findings'][0]['candidateNearbySegments'][0]['text'], 'Opening. Closing.')

    def test_large_replacement_requires_review_without_becoming_a_runtime_failure(self):
        report = audit.compare_documents(self.document('ref', 'one two three four five six seven eight nine ten'),
                                         self.document('new', 'red blue green white yellow black silver purple orange pink'))
        self.assertEqual(report['findings'][0]['reviewReason'], 'large-machine-text-replacement')
        self.assertEqual(report['status'], 'content-review')

    def test_repetition_collapse_is_not_blindly_called_missing_speech(self):
        report = audit.compare_documents(self.document('ref', 'first a repeated phrase with five words a repeated phrase with five words last'),
                                         self.document('new', 'first a repeated phrase with five words last'))
        self.assertTrue(report['findings'][0]['candidateExactPhraseOccurrences'])
        self.assertEqual(report['findings'][0]['reviewReason'], 'reference-phrase-present-elsewhere-or-repeated')

    def test_partial_segment_mapping_preserves_canonical_text_and_warns_instead_of_dropping_words(self):
        document = self.document('partial', 'all words need to be preserved here', segments=[{'start': 0, 'end': 4, 'text': 'all words'}])
        self.assertEqual(document['words'], audit.normalize_words('all words need to be preserved here'))
        self.assertEqual(document['mappingWarnings'][0]['code'], 'canonical-text-needs-owning-part-time')
        outside = self.document('outside', 'spoken words stay available', end=13)
        self.assertEqual(outside['mappingWarnings'][0]['code'], 'segment-outside-owning-input')


if __name__ == '__main__':
    unittest.main()
