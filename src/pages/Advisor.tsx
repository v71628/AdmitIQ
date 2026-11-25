import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LuSend, LuSquare, LuPlus, LuTrash2, LuDownload, LuCopy, LuPin, LuPencil, LuSparkles, LuSearch, LuMessagesSquare } from 'react-icons/lu';
import { useCaps } from '../App';
import { Badge, Button, Card, EmptyState, ExtLink, Notice, PageHeader, Textarea, Toggle, cx, copyText, downloadFile, useToast } from '../components/ui';
import { ai, ApiError, type AITask, type ChatMessage, type WebCitation } from '../lib/services';
import { Markdown } from '../lib/markdown';
import { store, uid } from '../lib/store';
import { contextForLLM } from '../lib/strategist';

// Conversations are stored in this browser (the server never keeps them unless the student signs in
// and turns on history in Settings). Each answer records which provider/model wrote it.
interface Msg { id: string; role: 'user' | 'assistant'; content: string; mode?: Mode; citations?: WebCitation[]; grounded?: boolean; provider?: string; model?: string; error?: string; pinned?: boolean; at: string }
interface Conv { id: string; title: string; folder: string; messages: Msg[]; updated: string }
type Mode = 'quick' | 'deep' | 'research';

const KEY = 'admitiq:advisor:v1';
const MODES: { id: Mode; label: string; task: AITask; desc: string }[] = [
  { id: 'quick', label: 'Quick answer', task: 'chat', desc: 'Fast, low-cost model. Good for definitions and simple questions.' },
  { id: 'deep', label: 'Deep analysis', task: 'analysis', desc: 'Stronger model for strategy, comparisons and your college list.' },
  { id: 'research', label: 'Research with sources', task: 'research', desc: 'Searches the web (Google Search grounding) and cites every source.' },
];
const STARTERS = [
  'Which schools on my list are reaches, targets and likely — and why?',
  'What should I focus on this semester to strengthen my application?',
  'Is it smart for me to apply Early Decision anywhere?',
  'Compare the cost of my top three colleges for a family like mine.',
];
const SYSTEM = `You are AdmitIQ's college admissions advisor for a high-school student.
Rules: Be specific to the student's profile when it is provided. Never invent statistics, deadlines, programs or experiences — if you do not know, say so and suggest the official source to check. Never claim admissions probabilities are precise and never guarantee admission. Separate facts (with where they come from) from your opinion. Keep the student's own voice in any writing help; do not write essays for them. Use short paragraphs, bullet lists and tables where helpful.`;

const load = (): Conv[] => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
const save = (c: Conv[]) => { try { localStorage.setItem(KEY, JSON.stringify(c.slice(0, 200))); } catch { /* storage full or blocked */ } };
const newConv = (): Conv => ({ id: uid(), title: 'New conversation', folder: '', messages: [], updated: new Date().toISOString() });

function toMarkdown(c: Conv) {
  return `# ${c.title}\n\n` + c.messages.map((m) => `**${m.role === 'user' ? 'You' : `AdmitIQ advisor${m.model ? ` (${m.provider} · ${m.model})` : ''}`}**\n\n${m.content}${m.citations?.length ? `\n\nSources:\n${m.citations.map((s) => `[${s.index}] ${s.title} — ${s.url}`).join('\n')}` : ''}`).join('\n\n---\n\n');
}

export default function Advisor() {
  const { caps, checked } = useCaps();
  const toast = useToast();
  const [convs, setConvs] = useState<Conv[]>(() => { const c = load(); return c.length ? c : [newConv()]; });
  const [activeId, setActiveId] = useState(() => convs[0].id);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<Mode>('quick');
  const [useProfile, setUseProfile] = useState(true);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [openCite, setOpenCite] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const active = convs.find((c) => c.id === activeId) || convs[0];

  useEffect(() => { save(convs); }, [convs]);
  useEffect(() => { const el = listRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }, [active?.messages.length, busy, active?.messages[active.messages.length - 1]?.content.length]);

  const update = (id: string, fn: (c: Conv) => Conv) => setConvs((cs) => cs.map((c) => (c.id === id ? fn(c) : c)).sort((a, b) => b.updated.localeCompare(a.updated)));
  const patchMsg = (cid: string, mid: string, patch: Partial<Msg>) => update(cid, (c) => ({ ...c, messages: c.messages.map((m) => (m.id === mid ? { ...m, ...patch } : m)) }));
  const shown = useMemo(() => convs.filter((c) => !filter || (c.title + ' ' + c.folder + ' ' + c.messages.map((m) => m.content).join(' ')).toLowerCase().includes(filter.toLowerCase())), [convs, filter]);
  const folders = useMemo(() => [...new Set(shown.map((c) => c.folder))].sort(), [shown]);

  async function send(text = input) {
    const q = text.trim(); if (!q || busy || !active) return;
    setInput('');
    const cid = active.id;
    const userMsg: Msg = { id: uid(), role: 'user', content: q, at: new Date().toISOString() };
    const reply: Msg = { id: uid(), role: 'assistant', content: '', mode, at: new Date().toISOString() };
    update(cid, (c) => ({ ...c, title: c.messages.length ? c.title : q.slice(0, 70), messages: [...c.messages, userMsg, reply], updated: new Date().toISOString() }));
    const history: ChatMessage[] = [...active.messages, userMsg].filter((m) => !m.error).slice(-12).map((m) => ({ role: m.role, content: m.content }));
    const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM + (useProfile ? `\n\nSTUDENT PROFILE (JSON, may be partial):\n${contextForLLM(store.get())}` : '\n\nThe student chose not to share their profile in this conversation.') }, ...history];
    const task = MODES.find((m) => m.id === mode)!.task;
    setBusy(true);
    try {
      if (task === 'research') {
        const r = await ai.run('research', messages);
        patchMsg(cid, reply.id, { content: r.text, citations: r.citations, grounded: r.grounded, provider: r.provider, model: r.model });
      } else {
        abort.current = new AbortController();
        let acc = '';
        const done = await ai.stream(messages, task, (d) => { acc += d; patchMsg(cid, reply.id, { content: acc }); }, abort.current.signal);
        patchMsg(cid, reply.id, { content: acc, provider: done.provider, model: done.model });
      }
    } catch (e) {
      const err = e as ApiError;
      const msg = err.name === 'AbortError' ? 'Stopped.' : err.code === 'quota' ? `${err.message} Upgrade for higher limits.` : err.code === 'plan_required' ? `${err.message}` : err.message || 'Something went wrong.';
      setConvs((cs) => cs.map((c) => (c.id === cid ? { ...c, messages: c.messages.map((m) => (m.id === reply.id ? { ...m, error: msg } : m)) } : c)));
    } finally { setBusy(false); abort.current = null; }
  }

  function newChat() { const c = newConv(); setConvs((cs) => [c, ...cs]); setActiveId(c.id); }
  function remove(id: string) {
    setConvs((cs) => { const rest = cs.filter((c) => c.id !== id); const next = rest.length ? rest : [newConv()]; if (id === activeId) setActiveId(next[0].id); return next; });
  }
  function rename(c: Conv) {
    const title = window.prompt('Conversation title', c.title); if (title === null) return;
    const folder = window.prompt('Folder (optional, e.g. "Essays" or "Financial aid")', c.folder);
    update(c.id, (x) => ({ ...x, title: title.trim() || x.title, folder: (folder ?? x.folder).trim() }));
  }

  if (checked && !caps?.ai) {
    return (
      <div className="space-y-6">
        <PageHeader title="AI advisor" desc="A conversational advisor that knows your profile, cites its sources and streams its answers." />
        <EmptyState icon={<LuMessagesSquare />} title="AI isn't connected on this server yet" body="The advisor needs an AI provider (OpenAI, Gemini, Anthropic or Groq) configured on the server — keys are never put in the browser. Until then, the rule-based AI strategist answers the most common questions from your profile." action={<div className="flex flex-wrap justify-center gap-2"><Button variant="primary" onClick={() => (location.hash = 'strategist')}>Open the strategist</Button><Button onClick={() => (location.hash = 'pricing')}>Plans</Button></div>} />
      </div>
    );
  }

  const pinned = convs.flatMap((c) => c.messages.filter((m) => m.pinned).map((m) => ({ c, m })));
  return (
    <div className="space-y-6">
      <PageHeader title="AI advisor" desc="Ask anything about colleges, applications, majors or costs. Answers use your profile only if you allow it." actions={<Button icon={<LuPlus />} onClick={newChat}>New chat</Button>} />
      <div className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
        <Card className="order-2 h-fit p-3 lg:order-none lg:sticky lg:top-6">
          <label className="flex h-10 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-sm"><LuSearch className="text-muted" /><input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search conversations" className="min-w-0 flex-1 bg-transparent outline-none" /></label>
          <div className="mt-3 max-h-[60vh] space-y-3 overflow-y-auto">
            {folders.map((f) => (
              <div key={f || '_'}>
                {f && <div className="px-2 pb-1 text-xs font-medium text-muted">{f}</div>}
                <ul className="space-y-0.5">
                  {shown.filter((c) => c.folder === f).map((c) => (
                    <li key={c.id} className={cx('group flex items-center rounded-xl', c.id === active.id ? 'bg-raised ring-1 ring-line' : 'hover:bg-raised/60')}>
                      <button className="min-w-0 flex-1 truncate px-3 py-2 text-left text-sm" onClick={() => setActiveId(c.id)} title={c.title}>{c.title}</button>
                      <button className="p-2 text-muted opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label={`Rename ${c.title}`} onClick={() => rename(c)}><LuPencil /></button>
                      <button className="p-2 text-muted opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label={`Delete ${c.title}`} onClick={() => remove(c.id)}><LuTrash2 /></button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {pinned.length > 0 && <div className="mt-4 border-t border-line pt-3"><div className="px-2 pb-1 text-xs font-medium text-muted">Saved answers</div>{pinned.slice(0, 8).map(({ c, m }) => <button key={m.id} onClick={() => setActiveId(c.id)} className="block w-full truncate rounded-lg px-2 py-1.5 text-left text-sm hover:bg-raised">{m.content.slice(0, 60)}</button>)}</div>}
        </Card>

        <Card className="flex h-[calc(100dvh-150px)] min-h-[460px] flex-col p-0 lg:h-[calc(100dvh-200px)] lg:min-h-[560px]">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
            <div className="min-w-0 flex-1 truncate font-medium text-ink">{active.title}</div>
            <Button size="sm" variant="ghost" icon={<LuDownload />} disabled={!active.messages.length} onClick={() => downloadFile(`${active.title.replace(/[^\w -]/g, '').slice(0, 40) || 'conversation'}.md`, toMarkdown(active), 'text/markdown')}>Export</Button>
          </div>
          <div ref={listRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5" aria-live="polite">
            {!active.messages.length && (
              <div className="mx-auto max-w-xl py-8 text-center">
                <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-accent/10 text-xl text-accent"><LuSparkles /></div>
                <h2 className="mt-3 text-lg font-semibold text-ink">What would you like to work on?</h2>
                <div className="mt-4 grid gap-2 sm:grid-cols-2">{STARTERS.map((s) => <button key={s} onClick={() => send(s)} className="rounded-xl border border-line bg-surface p-3 text-left text-sm text-ink transition hover:-translate-y-0.5 hover:border-ink/20 hover:shadow-card">{s}</button>)}</div>
              </div>
            )}
            {active.messages.map((m) => m.role === 'user' ? (
              <div key={m.id} className="flex justify-end"><div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-[15px] text-surface">{m.content}</div></div>
            ) : (
              <div key={m.id} className="max-w-[92%]">
                <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                  <Badge tone="violet">AI interpretation</Badge>
                  {m.mode === 'research' && <Badge tone={m.grounded ? 'green' : 'amber'}>{m.grounded ? 'Web-grounded' : 'Not web-grounded'}</Badge>}
                  {m.model && <span>{m.provider} · {m.model}</span>}
                </div>
                {m.error ? <Notice tone="warn">{m.error}{/upgrade|plan/i.test(m.error) && <> <a className="underline" href="#pricing">See plans</a></>}</Notice>
                  : m.content ? <Markdown text={m.content} onCite={(n) => setOpenCite(`${m.id}:${n}`)} />
                  : <div className="flex items-center gap-2 text-sm text-muted"><span className="pulse-dot h-2 w-2 rounded-full bg-accent" />{m.mode === 'research' ? 'Searching and reading sources…' : 'Thinking…'}</div>}
                {!!m.citations?.length && (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {m.citations.map((s) => (
                      <a key={s.index} href={s.url} target="_blank" rel="noopener noreferrer" className={cx('flex gap-2 rounded-xl border bg-surface p-2.5 text-sm transition hover:border-ink/20', openCite === `${m.id}:${s.index}` ? 'border-accent ring-2 ring-accent/20' : 'border-line')}>
                        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-raised text-[11px] font-medium text-muted">{s.index}</span>
                        <span className="min-w-0"><span className="block truncate font-medium text-ink">{s.title || 'Source'}</span><span className="block truncate text-xs text-muted">{(() => { try { return new URL(s.url).host; } catch { return s.url; } })()}</span></span>
                      </a>
                    ))}
                  </div>
                )}
                {m.content && !m.error && (
                  <div className="mt-2 flex gap-1 text-muted">
                    <Button size="sm" variant="ghost" icon={<LuCopy />} onClick={async () => { await copyText(m.content); toast('Copied'); }}>Copy</Button>
                    <Button size="sm" variant="ghost" icon={<LuPin />} onClick={() => patchMsg(active.id, m.id, { pinned: !m.pinned })}>{m.pinned ? 'Saved' : 'Save'}</Button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <form className="border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <div className="mb-2 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Answer mode">
              {MODES.map((m) => <button type="button" role="radio" aria-checked={mode === m.id} key={m.id} title={m.desc} onClick={() => setMode(m.id)} className={cx('rounded-full border px-3 py-1 text-xs transition', mode === m.id ? 'border-ink bg-ink text-surface' : 'border-line text-muted hover:text-ink')}>{m.label}</button>)}
            </div>
            <div className="flex items-end gap-2">
              <Textarea rows={2} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} placeholder="Ask about colleges, essays, majors, costs…" aria-label="Message" className="min-h-[52px] flex-1 resize-none" />
              {busy && mode !== 'research' ? <Button type="button" icon={<LuSquare />} onClick={() => abort.current?.abort()}>Stop</Button> : <Button type="submit" variant="primary" icon={<LuSend />} disabled={!input.trim() || busy}>Send</Button>}
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <Toggle checked={useProfile} onChange={setUseProfile} label="Use my profile" desc="Grades, tests, activities and list. Financial details only if you allowed it in your profile." />
              <span className="text-xs text-muted">AI can be wrong. Check deadlines and requirements on official sites. <ExtLink href="https://studentaid.gov">studentaid.gov</ExtLink></span>
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
}
