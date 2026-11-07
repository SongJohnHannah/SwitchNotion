import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const words = text => String(text).toLowerCase().replaceAll('’', "'").match(/[a-z0-9]+(?:'[a-z]+)?/g) || [];
const anchors = [
  { id: '94-short-clause', window: [90, 100], uncertainEnding: 'V1 says jacket; whole30 says track. The final word is not judged.',
    groups: [{ id: 'shared-clause-body', variants: ['this is the right'] }] },
  { id: '2274-honest-agreement', window: [2270, 2284], groups: [
    { id: 'honest', variants: ["let's be honest", 'let us be honest'] }, { id: 'agreement', variants: ['i agree with you'] }] },
  { id: '2732-full-question', window: [2728, 2745], groups: [
    { id: 'question', variants: ['are you having fun being on the frontier of humanity', 'are you having fun on the frontier of humanity'] }] },
  { id: '2790-tail-appreciation', window: [2786, 2806.0373125], groups: [
    { id: 'appreciation', variants: ['thanks man appreciate you', 'thanks man i appreciate you', 'thank you man appreciate you'] }] },
  { id: '1470-1500-phone', window: [1466, 1502], groups: [
    { id: 'chip', variants: ['complex computer chip'] }, { id: 'copy-ten-years', variants: ['nobody can copy for 10 years', 'nobody can copy for ten years'] },
    { id: 'speaker', variants: ['put me on speaker'] }, { id: 'china', variants: ['happiest group is china'] }, { id: 'states', variants: ['states are happy'] }] },
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function phraseIndex(sequence, phrase) {
  const needle = words(phrase);
  return sequence.findIndex((_, index) => needle.every((word, offset) => sequence[index + offset] === word));
}

export const reportSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'Named whole120 regression coverage, not human accuracy', type: 'object',
  required: ['version', 'status', 'candidate', 'checks', 'failedChecks', 'limitations'],
  properties: { version: { const: 1 }, status: { enum: ['FAIL', 'PASS_NAMED_ANCHORS_ONLY', 'NO_APPLICABLE_CHECKS'] },
    candidate: { type: 'object', required: ['directory', 'checkpointSha256', 'offsetSeconds', 'availableRange'] },
    checks: { type: 'array', items: { type: 'object', required: ['id', 'window', 'status', 'groups', 'originalSegments'],
      properties: { status: { enum: ['PASS', 'FAIL', 'NOT_IN_INPUT'] }, originalSegments: { type: 'array' }, groups: { type: 'array' } } } },
    failedChecks: { type: 'array', items: { type: 'string' } }, limitations: { type: 'array', items: { type: 'string' } }, controls: { type: 'array' } },
};

export function checkWhole120Coverage({ directory, offsetSeconds = 0 } = {}) {
  if (!Number.isFinite(offsetSeconds) || offsetSeconds < 0) throw Error('offsetSeconds must be a nonnegative original-video offset.');
  directory = path.resolve(directory);
  const checkpointFile = path.join(directory, 'checkpoint.json'), bytes = fs.readFileSync(checkpointFile);
  const checkpoint = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(checkpoint.parts) || !checkpoint.parts.length) throw Error('Checkpoint has no input parts.');
  const segments = [], integrityIssues = []; let expected = 0;
  for (const [index, part] of checkpoint.parts.entries()) {
    if (!Number.isInteger(part.startSample) || !Number.isInteger(part.samples) || part.samples <= 0 || part.startSample !== expected) integrityIssues.push({ partIndex: index, code: 'non-contiguous-input-parts' });
    expected = part.startSample + part.samples;
    const owningInput = [part.startSample / 16000 + offsetSeconds, expected / 16000 + offsetSeconds];
    if (!Array.isArray(part.segments)) { integrityIssues.push({ partIndex: index, code: 'missing-generated-segments' }); continue; }
    for (const [segmentIndex, segment] of part.segments.entries()) {
      if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end < segment.start || typeof segment.text !== 'string') {
        integrityIssues.push({ partIndex: index, segmentIndex, code: 'invalid-generated-segment' }); continue;
      }
      segments.push({ partIndex: index, segmentIndex, start: segment.start + offsetSeconds, end: segment.end + offsetSeconds,
        text: segment.text, owningInput, outsideOwningInput: segment.start + offsetSeconds < owningInput[0] - .1 || segment.end + offsetSeconds > owningInput[1] + .1 });
    }
  }
  const availableRange = [checkpoint.parts[0].startSample / 16000 + offsetSeconds, expected / 16000 + offsetSeconds];
  const checks = anchors.map(check => {
    const originalSegments = segments.filter(segment => segment.start < check.window[1] && segment.end > check.window[0]);
    const sequence = [], owner = [];
    for (const segment of originalSegments) for (const word of words(segment.text)) { sequence.push(word); owner.push(segment); }
    const applicable = availableRange[0] < check.window[1] && availableRange[1] > check.window[0];
    const groups = check.groups.map(group => {
      const variant = group.variants.find(variant => phraseIndex(sequence, variant) >= 0);
      const index = variant ? phraseIndex(sequence, variant) : -1;
      const evidence = index >= 0 ? [...new Set(owner.slice(index, index + words(variant).length))] : [];
      return { id: group.id, acceptedVariants: group.variants, found: Boolean(variant), matchedVariant: variant || null, evidence };
    });
    return { id: check.id, window: check.window, uncertainEnding: check.uncertainEnding || null,
      status: !applicable ? 'NOT_IN_INPUT' : groups.every(group => group.found) ? 'PASS' : 'FAIL', groups, originalSegments };
  });
  const failedChecks = checks.filter(check => check.status === 'FAIL').map(check => check.id);
  if (integrityIssues.length) failedChecks.push('input-or-segment-integrity');
  const evaluated = checks.filter(check => check.status !== 'NOT_IN_INPUT').length;
  return { version: 1, status: failedChecks.length ? 'FAIL' : evaluated ? 'PASS_NAMED_ANCHORS_ONLY' : 'NO_APPLICABLE_CHECKS',
    candidate: { directory, checkpointFile, checkpointSha256: sha(bytes), sourceIdentity: checkpoint.sourceIdentity || null,
      offsetSeconds, availableRange, inputSamples: expected, partCount: checkpoint.parts.length },
    evidenceTimeBasis: 'Original-video seconds; supplied offset added once. Segment bounds are approximate ASR times, not word acoustic alignment.',
    checks, failedChecks, integrityIssues, evaluatedChecks: evaluated,
    limitations: ['Named anchors derive from recorded multi-machine comparisons, not human ground truth or listening.',
      'PASS means only these named regressions were found. It is not full-content certification, WER or permission to promote.',
      'The 94-second final word jacket/track is explicitly uncertain and is not forced.',
      'No reference text is inserted into candidate output. All evidence comes from the candidate checkpoint.',
      'Original generated times, including owning-part overrun, are preserved without silent clamping.'], checkedAt: new Date().toISOString() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = {}, controls = [], args = process.argv.slice(2); let out, schemaOut;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (!value) throw Error('Missing value for ' + flag);
    if (flag === '--candidate') input.directory = value;
    else if (flag === '--offset-seconds') input.offsetSeconds = Number(value);
    else if (flag === '--control') controls.push(value);
    else if (flag === '--out') out = path.resolve(value);
    else if (flag === '--schema-out') schemaOut = path.resolve(value);
    else throw Error('Unknown argument ' + flag);
  }
  if (!input.directory || !out) throw Error('Usage: --candidate RUN --out REPORT.json [--control REF] [--offset-seconds ORIGINAL_START] [--schema-out SCHEMA.json]');
  for (const target of [out, schemaOut].filter(Boolean)) {
    if (path.extname(target) !== '.json' || ['checkpoint.json', 'result.json', 'machine.json'].includes(path.basename(target))) throw Error('Report must have a distinct .json filename; refusing to overwrite input/production metadata.');
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  const report = checkWhole120Coverage(input);
  report.controls = controls.map(directory => checkWhole120Coverage({ directory }));
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  if (schemaOut) fs.writeFileSync(schemaOut, JSON.stringify(reportSchema, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, failedChecks: report.failedChecks, controls: report.controls.map(c => ({ directory: c.candidate.directory, status: c.status, failedChecks: c.failedChecks })), reportFile: out }));
  process.exitCode = report.status === 'FAIL' ? 1 : report.status === 'NO_APPLICABLE_CHECKS' ? 2 : 0;
}
