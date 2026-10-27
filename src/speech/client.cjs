// Embedded only into the hash-checked native meeting module. Keep this
// function self-contained: the same implementation is exercised in tests.
function stopWithAudioFlush(actions, input, api) {
  const generation = actions.sessionOwnership.getCurrentGeneration();
  if (input.error || !api.state.state.rootBlock || !generation) return actions.stopDictationAfterLocalFlush(input);
  if (actions.localAudioStop) return actions.localAudioStop;
  const snapshot = api.state.state;
  // Release capture synchronously, before any encoder/write/ASR barrier. Keep
  // the native writer and its generation alive only to drain accepted audio.
  try {
    snapshot.audioRecorder?.stop({ triggerOnStop: false, triggerFlushToOPFS: true });
    api.captureStopped?.();
  } catch (error) { return actions.stopDictationAfterLocalFlush({ ...input, error }); }
  const owner = api.transport.H1();
  api.state.setState({ ...snapshot, enabled: false, loading: false, audioRecorderShouldAutoStopOnTranscriptionStateChanges: false });
  let stopped = false, stopResult, timer;
  const finish = value => {
    if (!stopped) {
      stopped = true;
      stopResult = actions.sessionOwnership.isCurrentGeneration(generation)
        ? actions.stopDictationAfterLocalFlush(value)
        : { revisionDrain: Promise.resolve(), startBarrier: Promise.resolve() };
    }
    return stopResult;
  };
  const flushing = (async () => {
    // Finish callbacks already encoding full frames while their generation
    // and connection still accept writes, then send even sub-frame tails.
    // Native AsyncQueue requires every queued callback to return a Promise.
    // Its own barrier does not insert a task or poison subsequent recordings.
    await actions.audioEncoderQueue.afterFlush();
    if (stopped || !actions.sessionOwnership.isCurrentGeneration(generation)) return;
    const tails = [[undefined, actions.audioBuffer], ...Object.entries(actions.sourceAudioBuffers)];
    actions.resetAudioBuffers();
    for (const [source, samples] of tails) {
      if (!samples.length) continue;
      const base64Audio = await actions.audioEncoderQueue.enqueue(() => api.encode([new Float32Array(samples)]));
      if (stopped || !actions.sessionOwnership.isCurrentGeneration(generation)) return;
      await api.send({ base64Audio, environment: input.environment, language: api.language(),
        blockId: snapshot.rootBlock.id, spaceId: snapshot.rootBlock.pointer.spaceId,
        ...(source ? { audioSource: source } : {}) });
    }
    await api.transport.Tg(owner);
  })();
  // Never leave capture and its connection alive behind a stalled encoder.
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('录音收尾超时，已停止录音；最后一段可能未完成。')), api.stopWaitMs ?? 1500); });
  const work = Promise.race([flushing, timeout]).then(() => finish(input), error => finish({ ...input, error }));
  const result = { failoverStopRecoveryStarted: false, detachedDrainStarted: true,
    revisionDrain: work.then(value => value.revisionDrain), startBarrier: work.then(value => value.startBarrier) };
  actions.localAudioStop = result;
  const cleanup = () => { clearTimeout(timer); if (actions.localAudioStop === result) actions.localAudioStop = undefined; };
  work.then(cleanup, cleanup);
  return result;
}

function replaceOnce(source, target, replacement) {
  if (source.split(target).length !== 2) throw Error('Unsupported native recording lifecycle');
  return source.replace(target, replacement);
}
function adaptRecordingClient(source, asset, { inputMode = 'meeting' } = {}) {
  if (!['microphone', 'meeting'].includes(inputMode)) throw Error('Invalid local recording input mode');
  if (asset.startsWith('17048-')) {
    return source;
  }
  source = replaceOnce(source, 'transcriptionDrainEnabled:i(218744).default.checkGate({gateName:"meeting_notes_transcription_drain_enabled"})', 'transcriptionDrainEnabled:!0');
  for (const entry of ['static async startDictation(e){', 'static async getDictationAudioRecorder(e){']) {
    source = replaceOnce(source, entry, entry + 'e={...e,includeSystemAudio:' + (inputMode === 'meeting' ? '!0' : '!1') + '};');
  }
  // The reviewed October 27 module only renames bindings. Resolve the store
  // alias by its exact module import rather than assuming the old name "y".
  const stores = [...source.matchAll(/\b([A-Za-z_$][\w$]*)=\(\)=>i\(585823\)/g)];
  if (stores.length !== 1) throw Error('Unsupported native recording store');
  const entry = 'static stopDictation(e){';
  const wrapper = entry + 'return (' + stopWithAudioFlush.toString() + ')(this,e,{state:' + stores[0][1] + '().Ay,transport:i(241978),send:i(216735).$g,encode:i(392719).Rk,captureStopped:()=>i(392719).c9({isCapturingAudio:!1}),language:()=>"auto"})}static stopDictationAfterLocalFlush(e){';
  return replaceOnce(source, entry, wrapper);
}
module.exports = { adaptRecordingClient, stopWithAudioFlush };
