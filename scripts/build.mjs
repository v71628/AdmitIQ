// AdmitIQ build: esbuild (TS/React) + Tailwind v4 (JS compiler API) -> dist/
// Usage: node scripts/build.mjs [--single]   (--single also writes dist/admitiq.html with everything inlined)
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const NODE_PATHS = [path.join(root, 'node_modules'), '/opt/npm-tools/node_modules', ...(process.env.NODE_PATH || '').split(':').filter(Boolean)];
const resolvePkg = (p) => { for (const b of NODE_PATHS) { const f = path.join(b, p); if (fs.existsSync(f)) return f; } return require.resolve(p); };

const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
const prod = process.env.NODE_ENV !== 'development';

// 1) JS bundle
const res = await build({
  entryPoints: [path.join(root, 'src/main.tsx')], bundle: true, minify: prod, sourcemap: prod ? false : 'inline', format: 'iife', target: ['es2020', 'safari15'],
  outfile: path.join(dist, 'app.js'), nodePaths: NODE_PATHS, jsx: 'automatic', define: { 'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development') },
  logLevel: 'warning', metafile: true, legalComments: 'none',
});

// 2) Tailwind CSS: scan source for candidate class tokens and compile
const twBase = path.dirname(resolvePkg('tailwindcss/package.json'));
const { compile } = await import(path.join(twBase, 'dist/lib.mjs'));
const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
const compiler = await compile(css, {
  base: root,
  loadStylesheet: async (id) => {
    const map = { tailwindcss: 'index.css', 'tailwindcss/theme': 'theme.css', 'tailwindcss/preflight': 'preflight.css', 'tailwindcss/utilities': 'utilities.css' };
    const f = path.join(twBase, map[id] || id.replace(/^tailwindcss\//, ''));
    return { path: f, base: twBase, content: fs.readFileSync(f, 'utf8') };
  },
});
const candidates = new Set();
const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(tsx?|html)$/.test(f)) for (const t of fs.readFileSync(p, 'utf8').split(/[\s"'`{}<>\\;]+/)) if (t && t.length < 160) { const c = t.replace(/^[,(]+|[,)]+$/g, ''); candidates.add(c); candidates.add(t); } } };
walk(path.join(root, 'src'));
const outCss = compiler.build([...candidates]);
fs.writeFileSync(path.join(dist, 'app.css'), outCss);

// 2b) Dataset as JSON for the server's research cross-checks
const dataOut = await build({ entryPoints: [path.join(root, 'src/data/colleges.ts')], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'error' });
const mod = await import('data:text/javascript;base64,' + Buffer.from(dataOut.outputFiles[0].text).toString('base64'));
fs.writeFileSync(path.join(dist, 'colleges.json'), JSON.stringify(mod.COLLEGES));

// 3) HTML shell
// ADMITIQ_API=https://… builds a static copy (e.g. GitHub Pages) that talks to that AdmitIQ server.
const apiBase = (process.env.ADMITIQ_API || '').trim().replace(/\/$/, '');
if (apiBase && !/^(https:\/\/[\w.-]+|http:\/\/(localhost|127\.0\.0\.1))(:\d+)?$/.test(apiBase)) throw new Error(`ADMITIQ_API must be an https origin, got ${apiBase}`);
// ADMITIQ_GOATCOUNTER=<code> adds GoatCounter visitor counting (https://<code>.goatcounter.com).
// Pages are hash routes (#advisor), so each route change counts as its own page view.
const goat = (process.env.ADMITIQ_GOATCOUNTER || '').trim().toLowerCase();
if (goat && !/^[a-z0-9-]{2,50}$/.test(goat)) throw new Error(`ADMITIQ_GOATCOUNTER must be a GoatCounter site code, got ${goat}`);
const goatTag = goat
  ? `  <script>window.goatcounter={path:function(){return location.pathname+location.hash.split('?')[0]}};addEventListener('hashchange',function(){if(window.goatcounter.count)window.goatcounter.count({path:location.pathname+location.hash.split('?')[0]})});</script>\n  <script data-goatcounter="https://${goat}.goatcounter.com/count" async src="https://gc.zgo.at/count.js"></script>\n</body>`
  : '</body>';
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8')
  .replace('<head>', () => (apiBase ? `<head>\n  <meta name="admitiq-api" content="${apiBase}" />` : '<head>'))
  .replace('</body>', () => goatTag);
fs.writeFileSync(path.join(dist, 'index.html'), html);
if (process.argv.includes('--single')) {
  const js = fs.readFileSync(path.join(dist, 'app.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
  // Function replacers: a string replacement would expand $&, $` and $' sequences inside the bundle.
  const single = html.replace('<link rel="stylesheet" href="app.css" />', () => `<style>${outCss}</style>`).replace('<script src="app.js" defer></script>', '').replace('</body>', () => `<script>${js}</script></body>`);
  fs.writeFileSync(path.join(dist, 'admitiq.html'), single);
}
// Security headers for static hosts that read a _headers file (Netlify, Cloudflare Pages).
fs.writeFileSync(path.join(dist, '_headers'), `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'
`);
const kb = (f) => (fs.statSync(path.join(dist, f)).size / 1024).toFixed(0) + ' KB';
console.log(`built dist/app.js ${kb('app.js')} · dist/app.css ${kb('app.css')}${process.argv.includes('--single') ? ` · dist/admitiq.html ${kb('admitiq.html')}` : ''}`);
void res;
