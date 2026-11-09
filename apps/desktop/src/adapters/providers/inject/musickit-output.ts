import { APPLE_OUTPUT_LIMITER_JS } from "./apple-output-limiter.js";

/** Page-side output setup, shared by explicit playback and MusicKit advances. */
export const MUSICKIT_OUTPUT_JS = String.raw`
function createMusicKitOutput() {
  let contextPromise = null;
  let limiter = null;
  let readyContext = null;
  let stateChain = Promise.resolve();
  let idleTimer = null;
  let activity = 0;
  const sources = new Map();
  const doc = window.document;
  async function context() {
    if (!contextPromise) {
      contextPromise = (async () => {
        const ctx = new window.AudioContext();
        try {
          const url = URL.createObjectURL(new Blob([${JSON.stringify(APPLE_OUTPUT_LIMITER_JS)}], { type: 'text/javascript' }));
          try { await ctx.audioWorklet.addModule(url); }
          finally { URL.revokeObjectURL(url); }
          limiter = new AudioWorkletNode(ctx, 'cadence-apple-limiter', {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
            channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
          });
          limiter.connect(ctx.destination);
          readyContext = ctx;
          return ctx;
        } catch (error) {
          await ctx.close();
          contextPromise = null;
          throw error;
        }
      })().catch(error => { contextPromise = null; throw error; });
    }
    return contextPromise;
  }
  function currentAudio() {
    if (!doc) return null;
    return Array.from(doc.querySelectorAll('audio')).find(element => !element.paused) || doc.querySelector('audio');
  }
  async function prepare(candidate) {
    const element = candidate || currentAudio();
    if (!element) return;
    const ctx = await context();
    // Recheck after module loading: the provider may have replaced its
    // media element while the asynchronous setup was in flight.
    const current = candidate && candidate.isConnected ? candidate : currentAudio();
    if (!current) return;
    if (!sources.has(current)) {
      const source = ctx.createMediaElementSource(current);
      source.connect(limiter);
      sources.set(current, source);
    }
    for (const [old, source] of sources) {
      if (old !== current && !old.isConnected && old.paused) {
        source.disconnect();
        sources.delete(old);
      }
    }
    if (!current.paused) await wake();
  }
  function enqueueState(work) {
    const next = stateChain.then(work, work);
    stateChain = next.catch(() => {});
    return next;
  }
  function cancelIdle() {
    activity++;
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
  }
  async function wake() {
    cancelIdle();
    const pending = contextPromise;
    if (!pending) return;
    await enqueueState(async () => {
      const ctx = await pending;
      if (ctx.state === 'suspended') await ctx.resume();
    });
  }
  async function pause() {
    cancelIdle();
    const pending = contextPromise;
    if (!pending) return;
    await enqueueState(async () => {
      const ctx = await pending;
      if (ctx.state === 'running') await ctx.suspend();
    });
  }
  function idle() {
    if (!readyContext || idleTimer !== null || readyContext.state !== 'running') return;
    const token = activity;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      void enqueueState(async () => {
        const element = currentAudio();
        if (token !== activity || (element && !element.paused && !element.ended)) return;
        if (readyContext.state === 'running') await readyContext.suspend();
      }).catch(error => emit('error', { message: 'Apple Music output suspension failed: ' + (error && error.message || error) }));
    }, tailMs());
  }
  function tailMs() {
    if (!readyContext) return 0;
    // A terminal SDK event refers to the input playhead. Allow the limiter
    // and the context's queued device audio to finish before ending intent.
    return Math.ceil(1000 * (0.005 + readyContext.baseLatency + (readyContext.outputLatency || 0) + 128 / readyContext.sampleRate));
  }
  function reset() {
    cancelIdle();
    if (limiter) limiter.port.postMessage({ type: 'reset' });
  }
  // Natural queue advances can create a new media element without a
  // controller.play call. Metadata arrives before audible playback.
  function onMediaReady(event) {
    if (event.target && event.target.tagName === 'AUDIO') {
      void prepare(event.target).catch(error => {
        emit('error', { message: 'Apple Music audio output failed: ' + (error && error.message || error) });
      });
    }
  }
  if (doc) {
    doc.addEventListener('loadedmetadata', onMediaReady, true);
    doc.addEventListener('play', onMediaReady, true);
  }
  return { prepare, reset, wake, pause, tailMs, idle };
}
`;
