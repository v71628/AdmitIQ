// AdmitIQ voice engine.
//  • Speech-to-text: the browser's Web Speech API when available (Chrome, Edge, Safari);
//    otherwise records audio and transcribes it on the AdmitIQ server (Groq/OpenAI Whisper).
//  • Text-to-speech: the browser's speechSynthesis (free, on-device).
// Audio never leaves the device in browser mode; in server mode it goes only to the configured provider.
import { useEffect, useRef, useState } from 'react';
import { apiUrl } from './services';

type SR = {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null;
};
const SRCtor = (): (new () => SR) | null => {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
};
export const browserSTT = () => !!SRCtor();
export const canRecord = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
export const ttsSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

const ERRORS: Record<string, string> = {
  'not-allowed': 'Microphone access was blocked. Allow the microphone for this site in your browser settings.',
  'service-not-allowed': 'Speech recognition is turned off in this browser.',
  'no-speech': "I didn't hear anything — try again a little closer to the mic.",
  'audio-capture': 'No microphone was found.',
  network: 'Speech recognition needs an internet connection in this browser.',
  aborted: '',
};

export interface Listener {
  supported: boolean; mode: 'browser' | 'server' | 'none'; listening: boolean; transcribing: boolean;
  interim: string; error: string; level: number; start: () => void; stop: () => void; toggle: () => void;
}

/** Hook: dictation. `onFinal` receives each finalized chunk of text. */
export function useListener({ onFinal, continuous = false, serverTranscribe = false }: { onFinal: (text: string) => void; continuous?: boolean; serverTranscribe?: boolean }): Listener {
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');
  const [level, setLevel] = useState(0);
  const rec = useRef<SR | null>(null);
  const media = useRef<{ mr: MediaRecorder; stream: MediaStream; raf: number; ctx: AudioContext } | null>(null);
  const finalRef = useRef(onFinal); finalRef.current = onFinal;
  const wantOn = useRef(false);
  const mode: Listener['mode'] = browserSTT() ? 'browser' : serverTranscribe && canRecord() ? 'server' : 'none';

  useEffect(() => () => { wantOn.current = false; rec.current?.abort(); stopMedia(); }, []);

  function stopMedia() {
    const m = media.current; if (!m) return;
    cancelAnimationFrame(m.raf); try { m.ctx.close(); } catch { /* ignore */ }
    if (m.mr.state !== 'inactive') m.mr.stop();
    m.stream.getTracks().forEach((t) => t.stop());
    media.current = null; setLevel(0);
  }

  async function start() {
    setError(''); setInterim('');
    stopSpeaking();
    if (mode === 'browser') {
      const r = new (SRCtor()!)();
      r.lang = navigator.language || 'en-US'; r.continuous = continuous; r.interimResults = true; r.maxAlternatives = 1;
      r.onresult = (e) => {
        let live = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          if (res.isFinal) finalRef.current(res[0].transcript.trim()); else live += res[0].transcript;
        }
        setInterim(live);
      };
      r.onerror = (e) => { if (ERRORS[e.error] !== '') setError(ERRORS[e.error] || `Voice error: ${e.error}`); if (e.error === 'not-allowed' || e.error === 'service-not-allowed') wantOn.current = false; };
      r.onend = () => { setInterim(''); if (wantOn.current && continuous) { try { r.start(); return; } catch { /* fall through */ } } setListening(false); wantOn.current = false; };
      rec.current = r; wantOn.current = true;
      try { r.start(); setListening(true); } catch (e) { setError((e as Error).message); }
      return;
    }
    if (mode === 'server') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
        const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        const chunks: Blob[] = [];
        mr.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
        mr.onstop = async () => {
          setListening(false);
          const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
          if (blob.size < 2000) { setError("I didn't hear anything — try again."); return; }
          setTranscribing(true);
          try { const text = await transcribe(blob); if (text) finalRef.current(text); else setError("I couldn't make out any words."); }
          catch (err) { setError((err as Error).message); }
          finally { setTranscribing(false); }
        };
        // Simple input-level meter so the user can see the mic is hearing them.
        const ctx = new AudioContext(); const an = ctx.createAnalyser(); an.fftSize = 256;
        ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Uint8Array(an.frequencyBinCount);
        const tick = () => { an.getByteTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v - 128)); setLevel(Math.min(1, m / 64)); if (media.current) media.current.raf = requestAnimationFrame(tick); };
        media.current = { mr, stream, raf: requestAnimationFrame(tick), ctx };
        mr.start(); setListening(true);
      } catch (e) {
        const n = (e as Error).name;
        setError(n === 'NotAllowedError' ? ERRORS['not-allowed'] : n === 'NotFoundError' ? ERRORS['audio-capture'] : `Couldn't start the microphone (${(e as Error).message}).`);
      }
      return;
    }
    setError('Voice input isn\'t available in this browser. Try Chrome, Edge or Safari — or type instead.');
  }
  function stop() { wantOn.current = false; rec.current?.stop(); if (media.current) stopMedia(); setListening(false); }
  return { supported: mode !== 'none', mode, listening, transcribing, interim, error, level, start, stop, toggle: () => (listening ? stop() : start()) };
}

async function transcribe(blob: Blob): Promise<string> {
  let token = '';
  try { token = JSON.parse(localStorage.getItem('admitiq:session') || 'null')?.access_token || ''; } catch { /* ignore */ }
  const r = await fetch(apiUrl('/api/transcribe'), { method: 'POST', headers: { 'content-type': blob.type || 'audio/webm', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: blob });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Transcription failed (${r.status})`);
  return String(d.text || '').trim();
}

// ---------- Text-to-speech ----------
let cachedVoice: SpeechSynthesisVoice | null = null;
function pickVoice() {
  if (!ttsSupported()) return null;
  if (cachedVoice) return cachedVoice;
  const voices = speechSynthesis.getVoices();
  const lang = (navigator.language || 'en-US').slice(0, 2);
  const pref = [/natural/i, /google us english/i, /samantha/i, /aria|jenny|guy/i, /daniel|karen|moira/i];
  const same = voices.filter((v) => v.lang?.toLowerCase().startsWith(lang));
  cachedVoice = pref.map((re) => same.find((v) => re.test(v.name))).find(Boolean) || same.find((v) => v.default) || same[0] || voices[0] || null;
  return cachedVoice;
}
if (ttsSupported()) speechSynthesis.onvoiceschanged = () => { cachedVoice = null; };

const speakListeners = new Set<(on: boolean) => void>();
let speakingNow = false;
const setSpeaking = (on: boolean) => { speakingNow = on; speakListeners.forEach((l) => l(on)); };

/** Speak text aloud. Long text is split into sentences (some engines cut off long utterances). */
export function speak(text: string, { rate = 1, onEnd }: { rate?: number; onEnd?: () => void } = {}) {
  if (!ttsSupported() || !text.trim()) { onEnd?.(); return; }
  speechSynthesis.cancel();
  const clean = text.replace(/[*_#`>]/g, '').replace(/\s+/g, ' ').trim();
  const parts = clean.match(/[^.!?]+[.!?]*\s*/g) || [clean];
  const chunks: string[] = []; let buf = '';
  for (const p of parts) { if ((buf + p).length > 220) { if (buf) chunks.push(buf); buf = p; } else buf += p; }
  if (buf) chunks.push(buf);
  setSpeaking(true);
  chunks.forEach((c, i) => {
    const u = new SpeechSynthesisUtterance(c);
    const v = pickVoice(); if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = rate;
    if (i === chunks.length - 1) { u.onend = () => { setSpeaking(false); onEnd?.(); }; u.onerror = () => { setSpeaking(false); onEnd?.(); }; }
    speechSynthesis.speak(u);
  });
}
export function stopSpeaking() { if (ttsSupported()) { speechSynthesis.cancel(); } if (speakingNow) setSpeaking(false); }
export function useSpeaking() {
  const [on, setOn] = useState(speakingNow);
  useEffect(() => { speakListeners.add(setOn); return () => { speakListeners.delete(setOn); }; }, []);
  return on;
}

// ---------- Spoken-answer analysis (interview coach) ----------
export const FILLERS = ['um', 'uh', 'erm', 'like', 'you know', 'i mean', 'basically', 'actually', 'literally', 'kind of', 'sort of', 'so yeah'];
export function analyzeSpeech(text: string, seconds: number) {
  const words = (text.match(/[A-Za-z0-9’']+/g) || []).length;
  const lower = ` ${text.toLowerCase()} `;
  const fillers = FILLERS.map((f) => ({ f, n: (lower.match(new RegExp(`[^a-z]${f.replace(' ', '\\s+')}[^a-z]`, 'g')) || []).length })).filter((x) => x.n);
  // "like" is often legitimate ("I'd like to"); only count it when it isn't preceded by a pronoun/would.
  const likeLegit = (lower.match(/(i'd|i would|would|we'd|you'd|they'd|i)\s+like\s+to/g) || []).length;
  const fl = fillers.map((x) => (x.f === 'like' ? { ...x, n: Math.max(0, x.n - likeLegit) } : x)).filter((x) => x.n);
  const fillerCount = fl.reduce((a, x) => a + x.n, 0);
  const wpm = seconds > 3 ? Math.round((words / seconds) * 60) : null;
  const specifics = (text.match(/\b\d[\d,.]*\b/g) || []).length + (text.match(/(?<!^|[.!?]\s)\b[A-Z][a-z]{2,}/g) || []).length;
  return { words, seconds: Math.round(seconds), wpm, fillers: fl, fillerCount, fillerRate: words ? fillerCount / words : 0, specifics };
}
