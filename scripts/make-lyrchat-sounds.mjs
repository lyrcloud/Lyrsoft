// Makes Lyr Chat's ringtones and message tones as small WAV files, synthesized here so they're our own.
// Writes lyrsoft/sounds/ (the web app, served at /sounds/) and mobile/android/app/src/main/res/raw/
// (the phone app's notification channels). Run: node scripts/make-lyrchat-sounds.mjs
import { mkdir, writeFile } from 'node:fs/promises';

const RATE = 22050;
const note = (n) => 440 * 2 ** ((n - 69) / 12); // MIDI note number → Hz

// A voice: partials [ratio, level, decay per second] under an attack/decay envelope.
const VOICES = {
  marimba: { attack: 0.004, partials: [[1, 1, 7], [4, 0.35, 22], [10, 0.08, 40]] },
  bell: { attack: 0.002, partials: [[1, 1, 2.2], [2.76, 0.45, 4], [5.4, 0.22, 7], [8.93, 0.1, 10]] },
  pluck: { attack: 0.003, partials: [[1, 1, 5], [2, 0.5, 8], [3, 0.25, 12], [4, 0.12, 16]] },
  soft: { attack: 0.02, partials: [[1, 1, 3], [2, 0.2, 6]] },
  glass: { attack: 0.001, partials: [[1, 1, 4], [2.32, 0.5, 6], [4.25, 0.3, 9], [6.63, 0.15, 12]] },
  pulse: { attack: 0.006, partials: [[1, 1, 6], [3, 0.33, 9], [5, 0.2, 12], [7, 0.14, 15]] },
  trill: { attack: 0.01, sustain: true, partials: [[1, 1, 0], [1.5, 0.8, 0]] },
};

// events: [startSeconds, midiNote, voice, gain, lengthSeconds?, glideSemitones?]
function render(seconds, events) {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (const [start, n, voiceName, gain = 1, len = 1.5, glide = 0] of events) {
    const v = VOICES[voiceName];
    const f0 = note(n);
    const s0 = Math.round(start * RATE);
    const count = Math.min(out.length - s0, Math.round(len * RATE));
    const phases = v.partials.map(() => 0);
    for (let i = 0; i < count; i++) {
      const t = i / RATE;
      const env = Math.min(1, t / v.attack) * (v.sustain ? Math.min(1, (len - t) / 0.03) : 1);
      const f = f0 * 2 ** ((glide * Math.min(1, t / len)) / 12);
      let s = 0;
      v.partials.forEach(([ratio, level, decay], k) => {
        if (f * ratio > RATE * 0.45) return; // above what the file can hold
        phases[k] += (2 * Math.PI * f * ratio) / RATE;
        s += Math.sin(phases[k]) * level * Math.exp(-decay * t);
      });
      out[s0 + i] += s * env * gain;
    }
  }
  return out;
}

function wav(samples, peak = 0.8) {
  let max = 0;
  for (const s of samples) max = Math.max(max, Math.abs(s));
  const scale = max ? (peak * 32767) / max : 0;
  const fade = Math.round(0.01 * RATE); // no click at the end
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => {
    const tail = Math.min(1, (samples.length - i) / fade);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * scale * tail))), 44 + i * 2);
  });
  return buf;
}

const seq = (voice, start, step, notes, gain, len) => notes.map((n, i) => [start + i * step, n, voice, gain, len]);

// Ringtones loop, so each is one phrase plus a pause.
const RINGTONES = {
  ring_classic: render(2.5, [[0, 81, 'trill', 1, 0.35], [0.48, 81, 'trill', 1, 0.35]]),
  ring_marimba: render(3, [...seq('marimba', 0, 0.16, [72, 76, 79, 84, 79, 76], 1, 0.9), ...seq('marimba', 1.1, 0.16, [72, 76, 79, 84], 1, 1.2)]),
  ring_bells: render(3.2, [...seq('bell', 0, 0.3, [88, 84, 86, 79], 0.9, 2), [1.4, 79, 'bell', 0.7, 1.6], [1.4, 86, 'bell', 0.5, 1.6]]),
  ring_harp: render(3, [...seq('pluck', 0, 0.07, [67, 71, 74, 79, 83, 86, 91], 0.8, 1.2), ...seq('pluck', 1.2, 0.07, [67, 71, 74, 79, 83, 86, 91], 0.8, 1.4)]),
  ring_pulse: render(2.6, [...seq('pulse', 0, 0.13, [76, 76, 83, 76], 1, 0.25), ...seq('pulse', 0.9, 0.13, [76, 76, 83, 88], 1, 0.3)]),
  ring_sunrise: render(3.4, [...seq('soft', 0, 0.22, [60, 64, 67, 72, 76], 1, 1.6), [1.1, 79, 'soft', 1, 1.8], [1.1, 72, 'soft', 0.6, 1.8]]),
};
const TONES = {
  tone_pop: render(0.25, [[0, 79, 'soft', 1, 0.2, -12]]),
  tone_ding: render(1.2, [[0, 88, 'bell', 1, 1.2]]),
  tone_bubble: render(0.45, [[0, 72, 'soft', 1, 0.12, 7], [0.13, 79, 'soft', 1, 0.15, 7]]),
  tone_glass: render(0.9, [[0, 91, 'glass', 1, 0.8], [0.12, 96, 'glass', 0.8, 0.8]]),
  tone_chord: render(1, [[0, 72, 'pluck', 1, 1], [0.03, 76, 'pluck', 0.8, 1], [0.06, 79, 'pluck', 0.7, 1]]),
  tone_marimba: render(0.7, [[0, 79, 'marimba', 1, 0.6], [0.11, 84, 'marimba', 1, 0.6]]),
};

const dirs = ['lyrsoft/sounds', 'mobile/android/app/src/main/res/raw'];
for (const dir of dirs) await mkdir(dir, { recursive: true });
for (const [name, samples] of Object.entries({ ...RINGTONES, ...TONES })) {
  const data = wav(samples, name.startsWith('tone_') ? 0.6 : 0.8);
  for (const dir of dirs) await writeFile(`${dir}/${name}.wav`, data);
}
console.log('Wrote', Object.keys(RINGTONES).length, 'ringtones and', Object.keys(TONES).length, 'message tones');
