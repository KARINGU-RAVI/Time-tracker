/**
 * Post-deploy smoke test. Run it against the live site right after a deploy:
 *
 *   node scripts/smoke.mjs https://your-site.netlify.app
 *
 * It only makes anonymous requests, so it needs no login and changes no data. It checks that the site is
 * served over HTTPS with the security headers, the app and its deep links load, the API is up, and, most
 * importantly, that everything private is locked and the sign-in wiring works.
 *
 * Options:  --local          allow http://localhost (skips the HTTPS checks)
 *           --origin=URL     the Origin to send on POSTs (default: the site address). Must equal APP_ORIGIN.
 */
import { pathToFileURL } from 'node:url';

const TIMEOUT_MS = 20_000;

async function http(url, init = {}) {
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

/** Runs every check and returns { results: [{name, ok, detail}], ok }. Nothing throws. */
export async function runSmoke(baseInput, options = {}) {
  const base = baseInput.replace(/\/$/, '');
  const origin = options.origin ?? base;
  const local = Boolean(options.local);
  const results = [];

  async function check(name, fn) {
    const started = Date.now();
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail ?? '', ms: Date.now() - started });
    } catch (e) {
      results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e), ms: Date.now() - started });
    }
  }
  const must = (cond, message) => {
    if (!cond) throw new Error(message);
  };

  await check('site is served over HTTPS', async () => {
    must(local || base.startsWith('https://'), `the address must start with https:// (got ${base})`);
  });

  if (!local) {
    await check('http:// redirects to https://', async () => {
      const r = await http(base.replace(/^https:/, 'http:') + '/');
      must([301, 302, 307, 308].includes(r.status), `expected a redirect, got ${r.status}`);
      must(String(r.headers.get('location')).startsWith('https://'), `redirect goes to ${r.headers.get('location')}`);
    });
  }

  let html = '';
  await check('the app loads', async () => {
    const r = await http(`${base}/`);
    must(r.status === 200, `GET / returned ${r.status}`);
    must(/text\/html/.test(r.headers.get('content-type') ?? ''), 'GET / is not HTML');
    must(r.text.includes('<div id="root">'), 'the page has no app root');
    must(/<title>Office Hours<\/title>/.test(r.text), 'unexpected page title');
    html = r.text;
    // Netlify's default for static files is "max-age=0, must-revalidate"; "no-cache"/"no-store" are equally fine.
    must(/no-cache|no-store|max-age=0/.test(r.headers.get('cache-control') ?? ''), `the page must always be re-checked (got "${r.headers.get('cache-control')}")`);
  });

  await check('deep links load the app (single-page fallback)', async () => {
    for (const path of ['/day/2026-09-17', '/calendar', '/settings']) {
      const r = await http(`${base}${path}`);
      must(r.status === 200 && r.text.includes('<div id="root">'), `${path} returned ${r.status}`);
    }
  });

  await check('security headers are present', async () => {
    const r = await http(`${base}/`);
    const h = (n) => r.headers.get(n) ?? '';
    const csp = h('content-security-policy');
    must(csp.includes("default-src 'self'"), 'Content-Security-Policy is missing or has no default-src');
    must(csp.includes("frame-ancestors 'none'"), 'CSP does not forbid framing');
    must(csp.includes('accounts.google.com'), 'CSP does not allow Google sign-in');
    must(csp.includes('challenges.cloudflare.com'), 'CSP does not allow the human check');
    must(!/unsafe-eval/.test(csp), 'CSP allows unsafe-eval');
    must(!/script-src[^;]*'unsafe-inline'/.test(csp), 'CSP allows inline scripts');
    must(h('x-content-type-options') === 'nosniff', 'X-Content-Type-Options is not nosniff');
    must(h('x-frame-options').toUpperCase() === 'DENY', 'X-Frame-Options is not DENY');
    must(/max-age=\d{7,}/.test(h('strict-transport-security')), 'Strict-Transport-Security is missing or short');
    must(h('referrer-policy') !== '', 'Referrer-Policy is missing');
  });

  await check('built files are cached for a long time', async () => {
    const match = /\/assets\/[^"']+\.js/.exec(html);
    must(match, 'could not find the app script in the page');
    const r = await http(`${base}${match[0]}`);
    must(r.status === 200, `${match[0]} returned ${r.status}`);
    must(/javascript/.test(r.headers.get('content-type') ?? ''), 'the script has the wrong content type');
    must(/immutable/.test(r.headers.get('cache-control') ?? ''), 'hashed files should be cached as immutable');
  });

  await check('the API is up and answers quickly', async () => {
    const started = Date.now();
    const r = await http(`${base}/api/health`);
    must(r.status === 200, `/api/health returned ${r.status}: ${r.text.slice(0, 120)}`);
    must(/json/.test(r.headers.get('content-type') ?? ''), '/api/health is not JSON');
    must(r.json?.ok === true, 'health response is not { ok: true }');
    must((r.headers.get('cache-control') ?? '') === 'private, no-cache', `API answers must not be stored by shared caches (got "${r.headers.get('cache-control')}")`);
    const skew = Math.abs(Date.parse(r.json.time) - Date.now());
    must(skew < 5 * 60_000, `the server clock differs from yours by ${Math.round(skew / 1000)}s`);
    return `${Date.now() - started} ms`;
  });

  await check('private endpoints are locked without sign-in', async () => {
    for (const path of ['/api/dashboard', '/api/backup', '/api/attendance/today', '/api/leave', '/api/export/csv?startDate=2026-09-01&endDate=2026-09-02']) {
      const r = await http(`${base}${path}`);
      must(r.status === 401, `${path} returned ${r.status} without a session (must be 401)`);
      must(r.json?.error?.code === 'UNAUTHENTICATED', `${path} did not return the UNAUTHENTICATED error`);
      must(!r.headers.get('set-cookie'), `${path} set a cookie for an anonymous caller`);
    }
  });

  await check('a wrong Google credential is refused cleanly (sign-in is wired up)', async () => {
    const r = await http(`${base}/api/auth/google`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ credential: 'x'.repeat(40) }),
    });
    must(r.status === 401, `expected 401, got ${r.status}: ${r.text.slice(0, 160)}`);
    must(r.json?.error?.code === 'INVALID_CREDENTIAL', `expected INVALID_CREDENTIAL, got ${r.json?.error?.code}`);
    must(!r.headers.get('set-cookie'), 'a cookie was issued for a bad credential');
  });

  await check('writes from another website are refused (CSRF)', async () => {
    const r = await http(`${base}/api/attendance/check-in`, { method: 'POST', headers: { origin: 'https://evil.example' } });
    must(r.status === 403, `expected 403, got ${r.status}`);
    must(r.json?.error?.code === 'BAD_ORIGIN', `expected BAD_ORIGIN, got ${r.json?.error?.code}`);
  });

  await check('errors are JSON and never leak internals', async () => {
    const r = await http(`${base}/api/auth/google`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{oops' });
    must(r.status === 400 && r.json?.error?.code === 'INVALID_JSON', `bad JSON returned ${r.status}`);
    must(!/at .*\.(ts|js):\d+|SELECT |prisma|node_modules/i.test(r.text), 'an error response contains internal details');
  });

  return { results, ok: results.every((r) => r.ok) };
}

function print({ results, ok }, base) {
  console.log(`\nSmoke test: ${base}\n`);
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
  const failed = results.filter((r) => !r.ok);
  console.log(ok ? `\nAll ${results.length} checks passed.\n` : `\n${failed.length} of ${results.length} checks FAILED.\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const base = args.find((a) => !a.startsWith('--'));
  if (!base) {
    console.error('Usage: node scripts/smoke.mjs https://your-site.netlify.app [--local] [--origin=URL]');
    process.exit(2);
  }
  const originArg = args.find((a) => a.startsWith('--origin='));
  const report = await runSmoke(base, { local: args.includes('--local'), origin: originArg?.slice('--origin='.length) });
  print(report, base);
  process.exit(report.ok ? 0 : 1);
}
