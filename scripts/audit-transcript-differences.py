"""CPU-only review aid for machine transcript differences, never a WER scorer.

Compare canonical checkpoint text with normalized word SequenceMatcher alignment.
Original segment text/times are retained as evidence; times are segment ranges,
not acoustic alignment of individual words. Findings require listening/review.
"""
import argparse
import difflib
import hashlib
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path


def normalize_words(text):
    return re.findall(r"[a-z0-9]+(?:'[a-z]+)?", text.lower().replace("’", "'"))


def load_document(directory):
    directory = Path(directory).resolve()
    checkpoint_file = directory / 'checkpoint.json'
    checkpoint = json.loads(checkpoint_file.read_text('utf-8-sig'))
    result_file = directory / 'result.json'
    result = json.loads(result_file.read_text('utf-8-sig')) if result_file.exists() else {}
    words, owners, mapping_warnings, coverage_issues = [], [], [], []
    expected = 0
    for position, part in enumerate(checkpoint['parts']):
        start_sample, samples = part['startSample'], part['samples']
        if start_sample != expected or samples <= 0:
            coverage_issues.append({'partIndex': position, 'expectedStartSample': expected,
                                    'startSample': start_sample, 'samples': samples})
        expected = start_sample + samples
        start, end = start_sample / 16000, expected / 16000
        segments = []
        for index, segment in enumerate(part.get('segments', [])):
            owner = {'partIndex': position, 'segmentIndex': index, 'start': segment.get('start'),
                     'end': segment.get('end'), 'owningPartStart': start, 'owningPartEnd': end,
                     'text': segment.get('text', '')}
            if (not all(isinstance(owner[k], (int, float)) and math.isfinite(owner[k]) for k in ['start', 'end'])
                    or owner['end'] < owner['start']):
                mapping_warnings.append({'code': 'invalid-segment-time', **owner})
            elif owner['start'] < start - .1 or owner['end'] > end + .1:
                mapping_warnings.append({'code': 'segment-outside-owning-input', **owner})
            segments.append(owner)
        canonical = normalize_words(part['text'])
        if [word for segment in segments for word in normalize_words(segment['text'])] != canonical:
            mapping_warnings.append({'code': 'canonical-text-needs-owning-part-time', 'partIndex': position})
            segments = [{'partIndex': position, 'segmentIndex': None, 'start': start, 'end': end,
                         'owningPartStart': start, 'owningPartEnd': end, 'text': part['text'],
                         'timeSource': 'owning-input-part-fallback'}]
        for segment in segments:
            text_words = normalize_words(segment['text'])
            words.extend(text_words)
            owners.extend([segment] * len(text_words))
    total_samples = result.get('totalSamples', checkpoint.get('totalSamples'))
    if total_samples is not None and expected != total_samples:
        coverage_issues.append({'code': 'sample-total-mismatch', 'partSamples': expected, 'declaredSamples': total_samples})
    transcript_file = directory / 'transcript.txt'
    if transcript_file.exists() and normalize_words(transcript_file.read_text('utf-8-sig')) != words:
        coverage_issues.append({'code': 'checkpoint-and-final-transcript-differ'})
    return {'directory': str(directory), 'checkpointFile': str(checkpoint_file), 'words': words,
            'owners': owners, 'mappingWarnings': mapping_warnings, 'coverageIssues': coverage_issues,
            'sampleEnd': expected, 'totalSamples': total_samples,
            'checkpointSha256': hashlib.sha256(checkpoint_file.read_bytes()).hexdigest(),
            'normalizedWordsSha256': hashlib.sha256(' '.join(words).encode()).hexdigest(),
            'runtime': {key: result.get(key) for key in ['complete', 'device', 'recoveries', 'nativeExits', 'transcriptSha256']}}


def original_segments(document, first, last, context_words=0):
    owners = document['owners']
    seen, result = set(), []
    left, right = max(0, first - context_words), min(len(owners), last + context_words)
    if left == right and owners:
        left, right = max(0, left - 1), min(len(owners), left + 1)
    for owner in owners[left:right]:
        key = (owner['partIndex'], owner['segmentIndex'])
        if key not in seen:
            seen.add(key)
            result.append(dict(owner))
    return result


def exact_occurrences(document, phrase):
    words, size = document['words'], len(phrase)
    return [{'wordRange': [i, i + size], 'segments': original_segments(document, i, i + size)}
            for i in range(len(words) - size + 1) if words[i:i + size] == phrase][:8]


def compare_documents(reference, candidate, min_deleted_words=4, large_replacement_words=8):
    before, after = reference['words'], candidate['words']
    matcher = difflib.SequenceMatcher(None, before, after, autojunk=False)
    findings = []
    for kind, i, j, k, last in matcher.get_opcodes():
        ref_size, new_size = j - i, last - k
        missing = kind in ('delete', 'replace') and ref_size >= min_deleted_words and ref_size - new_size >= min_deleted_words
        replacement = kind == 'replace' and max(ref_size, new_size) >= large_replacement_words
        if not (missing or replacement):
            continue
        occurrence = exact_occurrences(candidate, before[i:j]) if kind == 'delete' else []
        findings.append({'id': len(findings) + 1, 'alignmentOperation': kind,
                         'reviewReason': 'reference-phrase-present-elsewhere-or-repeated' if occurrence
                         else 'possible-omitted-clause' if missing else 'large-machine-text-replacement',
                         'referenceWordRange': [i, j], 'candidateWordRange': [k, last],
                         'referenceWordCount': ref_size, 'candidateWordCount': new_size,
                         'referenceNormalizedText': ' '.join(before[i:j]), 'candidateNormalizedText': ' '.join(after[k:last]),
                         'referenceSegments': original_segments(reference, i, j),
                         'candidateNearbySegments': original_segments(candidate, k, last, context_words=8),
                         'candidateExactPhraseOccurrences': occurrence})
    summarize = lambda doc: {key: doc[key] for key in ['directory', 'checkpointFile', 'checkpointSha256',
        'normalizedWordsSha256', 'sampleEnd', 'totalSamples', 'mappingWarnings', 'coverageIssues', 'runtime']}
    return {'version': 1, 'status': 'content-review' if findings or reference['coverageIssues'] or candidate['coverageIssues']
            or candidate['mappingWarnings'] else 'no-large-differences-found',
            'method': 'SequenceMatcher normalized words, autojunk=False; segment-level approximate times, not word acoustic alignment.',
            'limitations': ['Both inputs are machine transcripts, not human ground truth.',
                            'A deleted alignment span can be a reference hallucination, repetition collapse or moved wording.',
                            'Similarity is not WER, accuracy, full-content certification or permission to promote a profile.',
                            'Original segment times may cross owning input boundaries; warnings preserve them without silently clamping.'],
            'thresholds': {'minDeletedWords': min_deleted_words, 'largeReplacementWords': large_replacement_words},
            'reference': summarize(reference), 'candidate': summarize(candidate),
            'normalizedWordCounts': {'reference': len(before), 'candidate': len(after)},
            'sequenceSimilarityNotAccuracy': matcher.ratio(), 'findingCount': len(findings), 'findings': findings,
            'auditedAt': datetime.now(timezone.utc).isoformat()}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', required=True)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--min-deleted-words', type=int, default=4)
    args = parser.parse_args(argv)
    if args.min_deleted_words < 4:
        parser.error('min-deleted-words must be at least 4')
    report = compare_documents(load_document(args.reference), load_document(args.candidate), args.min_deleted_words)
    destination = Path(args.out)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', 'utf-8')
    print(json.dumps({'status': report['status'], 'findingCount': report['findingCount'], 'report': str(destination.resolve())}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
