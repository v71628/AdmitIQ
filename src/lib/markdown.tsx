// Tiny, safe Markdown renderer for AI answers: paragraphs, headings, bullet/numbered lists, bold, italics,
// inline code, fenced code, simple tables and [n] citation markers. Never injects HTML.
import React from 'react';

function inline(text: string, onCite?: (n: number) => void): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[(\d{1,2})\](?!\()|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0; let m: RegExpExecArray | null; let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(<strong key={k++} className="font-semibold text-ink">{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={k++} className="rounded bg-raised px-1 py-0.5 text-[0.9em]">{t.slice(1, -1)}</code>);
    else if (m[2]) {
      const n = Number(m[2]);
      out.push(<button key={k++} type="button" onClick={() => onCite?.(n)} className="mx-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-md border border-line bg-raised px-1 align-text-top text-[11px] font-medium text-muted hover:border-accent hover:text-accent" aria-label={`Source ${n}`}>{n}</button>);
    } else if (m[3] && m[4]) out.push(<a key={k++} href={m[4]} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2">{m[3]}</a>);
    else out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, onCite, className }: { text: string; onCite?: (n: number) => void; className?: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0; let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) {
      const body: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      blocks.push(<pre key={key++} className="overflow-x-auto rounded-xl bg-raised p-3 text-[13px]"><code>{body.join('\n')}</code></pre>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { blocks.push(<p key={key++} className={h[1].length <= 2 ? 'mt-2 text-base font-semibold text-ink' : 'mt-1 font-semibold text-ink'}>{inline(h[2], onCite)}</p>); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const row = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(line); i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(row(lines[i++]));
      blocks.push(
        <div key={key++} className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-left text-[13.5px]">
            <thead className="bg-raised text-muted"><tr>{head.map((c, j) => <th key={j} className="px-3 py-2 font-medium">{inline(c, onCite)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri} className="border-t border-line">{r.map((c, j) => <td key={j} className="px-3 py-2 align-top">{inline(c, onCite)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(<Tag key={key++} className={ordered ? 'list-decimal space-y-1 pl-5' : 'list-disc space-y-1 pl-5'}>{items.map((it, j) => <li key={j}>{inline(it, onCite)}</li>)}</Tag>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*([-*•]|\d+[.)])\s+|\s*\|)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) { para.push(lines[i++]); }
    blocks.push(<p key={key++}>{inline(para.join(' '), onCite)}</p>);
  }
  return <div className={className ?? 'space-y-3 text-[15px] leading-relaxed text-ink/90'}>{blocks}</div>;
}
