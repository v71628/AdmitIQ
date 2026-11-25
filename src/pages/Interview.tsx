import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LuMic, LuPlay, LuRotateCcw, LuArrowRight, LuVolume2, LuKeyboard, LuSparkles, LuTrash2, LuCheck } from 'react-icons/lu';
import { useCaps } from '../App';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Notice, PageHeader, Ring, Select, Textarea, Toggle, cx, useToast } from '../components/ui';
import { Columns } from '../components/charts';
import { MicButton } from '../components/assistant';
import { COLLEGES } from '../data/colleges';
import { store, uid, useStore } from '../lib/store';
import { pickQuestions, scoreAnswer, type AnswerFeedback, type Question } from '../lib/interview';
import { browserSTT, speak, stopSpeaking, useListener, useSpeaking } from '../lib/voice';
import { ai } from '../lib/services';
import { fmtDate } from '../lib/format';

type Phase = 'setup' | 'asking' | 'answering' | 'review' | 'done';

export default function Interview() {
  const s = useStore((x) => x);
  const { caps } = useCaps();
  const toast = useToast();
  const [collegeId, setCollegeId] = useState(() => { try { const v = sessionStorage.getItem('admitiq:interviewCollege'); sessionStorage.removeItem('admitiq:interviewCollege'); return v || s.list[0]?.collegeId || ''; } catch { return s.list[0]?.collegeId || ''; } });
  const [count, setCount] = useState(5);
  const [voiceOn, setVoiceOn] = useState(true);
  const [typed, setTyped] = useState(false);
  const [phase, setPhase] = useState<Phase>('setup');
  const [qs, setQs] = useState<Question[]>([]);
  const [i, setI] = useState(0);
  const [text, setTextState] = useState('');
  const textRef = useRef('');
  const setText = (v: string | ((x: string) => string)) => setTextState((x) => { const n = typeof v === 'function' ? v(x) : v; textRef.current = n; return n; });
  const [startedAt, setStartedAt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [fb, setFb] = useState<AnswerFeedback | null>(null);
  const [aiFb, setAiFb] = useState<{ loading: boolean; text: string }>({ loading: false, text: '' });
  const [answers, setAnswers] = useState<{ q: Question; transcript: string; seconds: number; fb: AnswerFeedback }[]>([]);
  const speaking = useSpeaking();
  const college = COLLEGES.find((c) => c.id === collegeId) || null;
  const listener = useListener({ continuous: true, serverTranscribe: !!caps?.ai?.transcribe, onFinal: (t) => setText((x) => (x ? `${x} ${t}` : t)) });
  const voiceInput = listener.supported && !typed;
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  useEffect(() => () => { stopSpeaking(); clearInterval(timer.current); }, []);

  const q = qs[i];
  function ask(idx: number, list = qs) {
    const question = list[idx];
    setPhase('asking'); setText(''); setFb(null); setAiFb({ loading: false, text: '' }); setElapsed(0);
    const startAnswer = () => {
      setPhase('answering'); const t0 = Date.now(); setStartedAt(t0);
      clearInterval(timer.current); timer.current = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500);
      if (voiceInput) listener.start();
    };
    if (voiceOn) speak(question.text(college), { onEnd: startAnswer }); else startAnswer();
  }
  function start() { const list = pickQuestions(count); setQs(list); setAnswers([]); setI(0); ask(0, list); }
  function finishAnswer() {
    listener.stop(); clearInterval(timer.current);
    const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    // Give the recognizer a moment to deliver its last words.
    setTimeout(() => {
      const t = textRef.current;
      const f = scoreAnswer(q, t, secs, college, !voiceInput);
      setFb(f); setAnswers((a) => [...a, { q, transcript: t, seconds: secs, fb: f }]); setPhase('review');
    }, voiceInput && listener.mode === 'browser' ? 700 : 50);
  }
  function next() {
    if (i + 1 < qs.length) { setI(i + 1); ask(i + 1); }
    else {
      setPhase('done');
      store.set((st) => { st.interviews.unshift({ id: uid(), collegeId, at: new Date().toISOString(), answers: answers.map((a) => ({ q: a.q.text(college), kind: a.q.kind, transcript: a.transcript, seconds: a.seconds, score: a.fb.score })) }); st.interviews = st.interviews.slice(0, 30); });
      if (voiceOn) speak('That\'s the end of the interview. Nice work — here\'s your summary.');
    }
  }
  async function aiFeedback() {
    if (!q) return;
    setAiFb({ loading: true, text: '' });
    try {
      const r = await ai.chat([{ role: 'system', content: 'You are a warm, honest college interview coach. Give 3 short, specific bullet points of feedback on the student\'s spoken answer (what worked, what to improve, one concrete suggestion). Quote their words when useful. Never invent facts about the student or the college. Under 120 words.' }, { role: 'user', content: `College: ${college?.name || 'general'}\nQuestion: ${q.text(college)}\nAnswer (speech transcript, ${elapsed}s): ${text}` }]);
      setAiFb({ loading: false, text: r.text });
    } catch (e) { setAiFb({ loading: false, text: `AI feedback unavailable: ${(e as Error).message}` }); }
  }
  const avg = answers.length ? Math.round((answers.reduce((x, a) => x + a.fb.score, 0) / answers.length) * 10) / 10 : 0;
  const history = s.interviews.filter((x) => x.answers.length).slice(0, 10).reverse();

  return (
    <>
      <PageHeader title="Interview coach" desc="Practice out loud. AdmitIQ asks real interview-style questions, listens to your answers, and coaches your pace, filler words, structure and specifics." />
      {phase === 'setup' && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Card className="p-5 sm:p-6">
            <CardHeader flush title="Set up a practice interview" />
            <div className="mt-4 grid gap-4">
              <Field label="College (for 'why us' questions)" htmlFor="iv-col"><Select id="iv-col" value={collegeId} onChange={(e) => setCollegeId(e.target.value)} options={[{ value: '', label: 'General practice' }, ...s.list.map((l) => ({ value: l.collegeId, label: COLLEGES.find((c) => c.id === l.collegeId)?.name || l.collegeId })), ...COLLEGES.filter((c) => !s.list.some((l) => l.collegeId === c.id)).map((c) => ({ value: c.id, label: c.name }))]} /></Field>
              <Field label="Number of questions" htmlFor="iv-n"><Select id="iv-n" value={String(count)} onChange={(e) => setCount(Number(e.target.value))} options={[{ value: '3', label: '3 — quick warm-up (~5 min)' }, { value: '5', label: '5 — standard (~10 min)' }, { value: '8', label: '8 — full interview (~20 min)' }]} /></Field>
              <Toggle label="Interviewer speaks the questions" desc="Uses your device's built-in voice." checked={voiceOn} onChange={setVoiceOn} />
              <Toggle label="Type answers instead of speaking" desc={listener.supported ? (listener.mode === 'server' ? 'Speech is transcribed by your AdmitIQ server (Whisper).' : 'Speech is transcribed by your browser.') : 'Voice input isn\'t available in this browser, so answers are typed.'} checked={typed || !listener.supported} onChange={setTyped} />
              <Button variant="primary" size="lg" icon={<LuPlay />} onClick={start}>Start interview</Button>
            </div>
          </Card>
          <Card className="p-5 sm:p-6">
            <CardHeader flush title="What you get" />
            <ul className="mt-3 space-y-2.5 text-sm text-muted">
              <li><b className="text-ink">Pace</b> — words per minute (≈130–160 sounds confident).</li>
              <li><b className="text-ink">Filler words</b> — "um", "uh", "like", "you know", "basically" counted per answer.</li>
              <li><b className="text-ink">Length</b> — most answers land best at 45–120 seconds.</li>
              <li><b className="text-ink">Specifics</b> — names, numbers and places that make you memorable.</li>
              <li><b className="text-ink">Structure</b> — for story questions: what you did, and what came of it.</li>
              <li><b className="text-ink">"Why us" check</b> — do you name something specific to the college?</li>
            </ul>
            <Notice className="mt-4">Recordings are never stored — only the text transcript and scores, in this browser. {browserSTT() ? 'Your browser does the speech recognition.' : caps?.ai?.transcribe ? 'Audio is sent only to your configured AI provider for transcription.' : ''} Scores are practice feedback, not how interviewers grade.</Notice>
          </Card>
          {history.length > 0 && (
            <Card className="p-5 lg:col-span-2">
              <CardHeader flush title="Your progress" desc="Average answer score per practice session." action={<Button size="sm" variant="ghost" icon={<LuTrash2 />} onClick={() => store.set((st) => { st.interviews = []; })}>Clear history</Button>} />
              <div className="mt-4"><Columns data={history.map((h) => ({ label: `${fmtDate(h.at).replace(/, \d{4}/, '')}${h.collegeId ? ` · ${COLLEGES.find((c) => c.id === h.collegeId)?.short}` : ''}`, value: Math.round((h.answers.reduce((a, x) => a + x.score, 0) / h.answers.length) * 10) / 10 }))} max={10} format={(v) => v.toFixed(1)} /></div>
            </Card>
          )}
        </div>
      )}

      {(phase === 'asking' || phase === 'answering' || phase === 'review') && q && (
        <div className="mx-auto max-w-3xl space-y-4">
          <div className="flex items-center justify-between text-sm text-muted"><span>Question {i + 1} of {qs.length}{college ? ` · ${college.short}` : ''}</span><button className="hover:text-ink" onClick={() => { listener.stop(); stopSpeaking(); clearInterval(timer.current); setPhase('setup'); }}>End interview</button></div>
          <div className="h-1.5 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${((i + (phase === 'review' ? 1 : 0)) / qs.length) * 100}%` }} /></div>
          <Card className="p-6 sm:p-8">
            <div className="flex items-start gap-4">
              <span className={cx('grid h-12 w-12 shrink-0 place-items-center rounded-full bg-ink text-canvas', speaking && 'mic-ring')} style={{ ['--lvl' as string]: 0.4 }}><LuVolume2 /></span>
              <div className="min-w-0 flex-1">
                <h2 className="text-balance text-[22px] font-semibold leading-snug tracking-tight text-ink sm:text-[26px]">{q.text(college)}</h2>
                <p className="mt-2 text-sm text-muted">Tip: {q.tip}</p>
              </div>
              <button onClick={() => speak(q.text(college))} aria-label="Repeat question" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-raised hover:text-accent"><LuRotateCcw /></button>
            </div>
            {phase === 'asking' && <p className="mt-6 flex items-center gap-2 text-sm text-muted"><span className="pulse-dot h-2 w-2 rounded-full bg-accent" />Interviewer is asking… <button className="text-accent hover:underline" onClick={() => { stopSpeaking(); }}>Skip</button></p>}
            {phase === 'answering' && (
              <div className="mt-6 space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  {voiceInput ? <MicButton listener={listener} label="Start speaking" /> : <LuKeyboard className="text-xl text-muted" />}
                  <span className="text-sm font-medium tabular-nums text-ink">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>
                  <span className={cx('text-sm', elapsed > 120 ? 'text-amber-600' : 'text-muted')}>{voiceInput ? (listener.listening ? 'Listening — answer naturally' : listener.transcribing ? 'Transcribing…' : 'Tap the mic to speak') : 'Type your answer as you would say it'}</span>
                  <Button variant="primary" className="ml-auto" icon={<LuCheck />} onClick={finishAnswer} disabled={listener.transcribing}>Done answering</Button>
                </div>
                {listener.error && <Notice tone="warn">{listener.error} <button className="font-medium text-accent hover:underline" onClick={() => setTyped(true)}>Type instead</button></Notice>}
                <Textarea aria-label="Your answer" rows={6} value={text + (listener.interim ? ` ${listener.interim}` : '')} onChange={(e) => setText(e.target.value)} placeholder={voiceInput ? 'Your words appear here as you speak. You can fix mistakes before finishing.' : 'Type your answer…'} />
              </div>
            )}
            {phase === 'review' && fb && (
              <div className="mt-6 space-y-4">
                <div className="flex flex-wrap items-center gap-5">
                  <Ring value={fb.score * 10} size={76} stroke={8} label={<span className="text-lg">{fb.score}</span>} tone={fb.score >= 7 ? 'var(--teal)' : fb.score >= 5 ? 'var(--accent)' : 'var(--c5)'} />
                  <dl className="grid flex-1 grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                    <div><dt className="text-muted">Length</dt><dd className="font-semibold tabular-nums text-ink">{fb.stats.seconds}s · {fb.stats.words}w</dd></div>
                    <div><dt className="text-muted">Pace</dt><dd className="font-semibold tabular-nums text-ink">{fb.stats.wpm && voiceInput ? `${fb.stats.wpm} wpm` : '—'}</dd></div>
                    <div><dt className="text-muted">Fillers</dt><dd className="font-semibold tabular-nums text-ink">{fb.stats.fillerCount}</dd></div>
                    <div><dt className="text-muted">Specifics</dt><dd className="font-semibold tabular-nums text-ink">{fb.stats.specifics}</dd></div>
                  </dl>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div><h3 className="text-sm font-semibold text-ink">What worked</h3><ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted">{fb.good.length ? fb.good.map((g) => <li key={g}>{g}</li>) : <li>Keep practicing — strengths show up as answers develop.</li>}</ul></div>
                  <div><h3 className="text-sm font-semibold text-ink">To improve</h3><ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted">{fb.improve.length ? fb.improve.map((g) => <li key={g}>{g}</li>) : <li>Nothing major — nice answer.</li>}</ul></div>
                </div>
                <details className="rounded-xl border border-line p-3 text-sm"><summary className="cursor-pointer text-muted">Your transcript</summary><p className="mt-2 whitespace-pre-wrap text-ink">{text || '—'}</p></details>
                {caps?.ai && (aiFb.text || aiFb.loading ? <div className="rounded-xl border border-violet-500/25 bg-violet-500/[0.05] p-4 text-sm"><Badge tone="violet" className="mb-2">AI coach · {caps.ai.model}</Badge><p className="whitespace-pre-wrap text-ink">{aiFb.loading ? 'Thinking…' : aiFb.text}</p></div> : <Button size="sm" icon={<LuSparkles />} onClick={aiFeedback}>Get AI coaching on this answer</Button>)}
                <div className="flex flex-wrap gap-2">
                  <Button variant="ghost" icon={<LuRotateCcw />} onClick={() => { setAnswers((a) => a.slice(0, -1)); ask(i); }}>Try again</Button>
                  <Button variant="primary" onClick={next}>{i + 1 < qs.length ? 'Next question' : 'Finish'} <LuArrowRight /></Button>
                </div>
              </div>
            )}
          </Card>
        </div>
      )}

      {phase === 'done' && (
        <div className="mx-auto max-w-3xl space-y-4">
          <Card className="p-6 sm:p-8">
            <div className="flex flex-wrap items-center gap-5"><Ring value={avg * 10} size={96} stroke={9} label={<span className="text-xl">{avg}</span>} tone="var(--teal)" /><div><h2 className="text-2xl font-semibold tracking-tight text-ink">Interview complete</h2><p className="text-muted">{answers.length} answers · average practice score {avg}/10 · {answers.reduce((a, x) => a + x.fb.stats.fillerCount, 0)} filler words total</p></div></div>
            <ol className="mt-6 space-y-3">
              {answers.map((a, k) => (
                <li key={k} className="rounded-xl border border-line p-4">
                  <div className="flex items-start justify-between gap-3"><span className="font-medium text-ink">{a.q.text(college)}</span><Badge tone={a.fb.score >= 7 ? 'teal' : a.fb.score >= 5 ? 'blue' : 'rose'}>{a.fb.score}/10</Badge></div>
                  <p className="mt-1 text-sm text-muted">{a.fb.stats.seconds}s · {a.fb.stats.words} words{a.fb.stats.wpm && voiceInput ? ` · ${a.fb.stats.wpm} wpm` : ''} · {a.fb.stats.fillerCount} fillers{a.fb.improve[0] ? ` — ${a.fb.improve[0]}` : ''}</p>
                </li>
              ))}
            </ol>
            <div className="mt-6 flex flex-wrap gap-2"><Button variant="primary" icon={<LuMic />} onClick={start}>Practice again</Button><Button onClick={() => setPhase('setup')}>Change settings</Button><Button variant="ghost" onClick={() => toast('Saved to your progress chart')}>Saved ✓</Button></div>
          </Card>
        </div>
      )}
      {phase === 'setup' && !s.list.length && <p className="mt-4 text-sm text-muted">Tip: add colleges to your list to get "why us" questions tailored to them.</p>}
      {void EmptyState}
    </>
  );
}
