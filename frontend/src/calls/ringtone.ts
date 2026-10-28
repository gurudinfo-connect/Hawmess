/** Soft ring generated with Web Audio (no audio files). Silently does nothing if the browser blocks audio before a user gesture. */
export function startRing(kind: 'incoming' | 'outgoing'): () => void {
  let ctx: AudioContext | null = null; let timer: any; let stopped = false;
  try {
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext; if (!AC) return () => {};
    ctx = new AC() as AudioContext;
    const beep = () => {
      if (!ctx || stopped) return; if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const t = ctx.currentTime; const g = ctx.createGain(); g.connect(ctx.destination); g.gain.setValueAtTime(0, t);
      const tones = kind === 'incoming' ? [[880, 0], [660, 0.25]] : [[440, 0]];
      for (const [f, at] of tones) { const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.connect(g); o.start(t + at); o.stop(t + at + 0.22); }
      g.gain.linearRampToValueAtTime(kind === 'incoming' ? 0.18 : 0.08, t + 0.03); g.gain.linearRampToValueAtTime(0, t + 0.5);
    };
    beep(); timer = setInterval(beep, kind === 'incoming' ? 2000 : 3000);
  } catch { /* audio unavailable */ }
  return () => { stopped = true; clearInterval(timer); try { ctx?.close(); } catch { /* ignore */ } };
}
