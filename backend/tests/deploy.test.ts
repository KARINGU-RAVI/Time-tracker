import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import type { Context, Handler } from 'aws-lambda';
import { build } from 'esbuild';
import serverless from 'serverless-http';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { devAuthenticator } from '../src/auth';
import { MemoryEmailSender } from '../src/email';
import type { GoogleVerifier } from '../src/google';
import { allowAllTurnstile } from '../src/turnstile';
import { createHandler, normalisePath } from '../src/lambda';
import { seedOwner } from '../prisma/seed-lib';
import { runSmoke } from '../../scripts/smoke.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const DIST = path.join(ROOT, 'frontend/dist');

const toml = parseToml(read('netlify.toml')) as {
  build: { base: string; command: string; publish: string; functions: string; environment: Record<string, string> };
  functions: { node_bundler: string; external_node_modules: string[]; included_files: string[] };
  redirects: Array<{ from: string; to: string; status: number; force?: boolean }>;
  headers: Array<{ for: string; values: Record<string, string> }>;
  context: Record<string, { command: string }>;
};

describe('netlify.toml', () => {
  it('builds the app from the repository root and publishes the right folders', () => {
    expect(toml.build).toMatchObject({ base: '.', publish: 'frontend/dist', functions: 'netlify/functions' });
    expect(toml.build.command).toContain('prisma generate --schema backend/prisma/schema.prisma');
    expect(toml.build.command).toContain('npm run build -w @oht/frontend');
    expect(toml.build.environment.NODE_VERSION).toBe('22');
    expect(existsSync(path.join(ROOT, 'netlify/functions/api.ts'))).toBe(true);
  });

  it('ships Prisma with its generated client next to the function, and every path exists', () => {
    expect(toml.functions.node_bundler).toBe('esbuild');
    expect(toml.functions.external_node_modules).toContain('@prisma/client');
    const files = toml.functions.included_files;
    expect(files).toEqual(expect.arrayContaining(['node_modules/.prisma/client/**', 'node_modules/@prisma/client/**', 'backend/prisma/schema.prisma']));
    for (const pattern of files) expect(existsSync(path.join(ROOT, pattern.replace(/\/\*\*$/, ''))), pattern).toBe(true);
  });

  it('sends /api/* to the function (forced, first) and everything else to the app (last)', () => {
    const r = toml.redirects;
    expect(r[0]).toEqual({ from: '/api/*', to: '/.netlify/functions/api/:splat', status: 200, force: true });
    expect(r.at(-1)).toMatchObject({ from: '/*', to: '/index.html', status: 200 });
    expect(r.findIndex((x) => x.from === '/api/*')).toBeLessThan(r.findIndex((x) => x.from === '/*'));
  });

  it('sets strict security headers, with a policy that still allows Google sign-in', () => {
    const all = toml.headers.find((h) => h.for === '/*')!.values;
    expect(all['Strict-Transport-Security']).toMatch(/max-age=\d{7,}/);
    expect(all['X-Content-Type-Options']).toBe('nosniff');
    expect(all['X-Frame-Options']).toBe('DENY');
    expect(all['Referrer-Policy']).toBeTruthy();
    expect(all['Permissions-Policy']).toContain('camera=()');
    const csp = all['Content-Security-Policy']!;
    const directive = (name: string) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '';
    expect(directive('default-src')).toBe("default-src 'self'");
    expect(directive('script-src')).toBe("script-src 'self' https://accounts.google.com/gsi/client");
    expect(csp).not.toMatch(/unsafe-eval/);
    expect(directive('script-src')).not.toMatch(/unsafe-inline/);
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive('object-src')).toBe("object-src 'none'");
    expect(directive('base-uri')).toBe("base-uri 'self'");
    for (const d of ['connect-src', 'frame-src']) expect(directive(d)).toContain('https://accounts.google.com/gsi/');
    expect(directive('style-src')).toContain('https://accounts.google.com/gsi/style');
  });

  it('caches built files for a year and never caches the page', () => {
    expect(toml.headers.find((h) => h.for === '/assets/*')!.values['Cache-Control']).toBe('public, max-age=31536000, immutable');
    expect(toml.headers.find((h) => h.for === '/index.html')!.values['Cache-Control']).toBe('no-cache');
  });

  it('fails preview and branch builds on purpose, so they never run with production secrets', () => {
    for (const ctx of ['deploy-preview', 'branch-deploy']) expect(toml.context[ctx]!.command).toMatch(/exit 1/);
  });

  it('the frontend csp does not need anything the built app loads from elsewhere', () => {
    // Every asset the build references must be same-origin (default-src/script-src are 'self').
    const html = readFileSync(path.join(DIST, 'index.html'), 'utf8');
    for (const url of html.match(/(?:src|href)="([^"]+)"/g) ?? []) expect(url).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[^<]/); // no inline scripts
  });
});

describe('deployment environment template', () => {
  const template = read('deploy/netlify.env.example');
  const assigned = new Set(template.split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split('=')[0]));

  it('lists every variable the deployed function requires, plus the build-time client id', () => {
    for (const key of ['DATABASE_URL', 'GOOGLE_CLIENT_ID', 'SESSION_SECRET', 'APP_ORIGIN', 'AUTH_MODE', 'BREVO_API_KEY', 'EMAIL_FROM', 'TURNSTILE_SECRET_KEY', 'VITE_GOOGLE_CLIENT_ID', 'VITE_TURNSTILE_SITE_KEY']) {
      expect(assigned.has(key), key).toBe(true);
    }
    expect(template).toContain('AUTH_MODE="google"');
    expect(assigned.has('ALLOWED_EMAIL')).toBe(false); // sign-up is open now; access is controlled by the account cap
  });

  it('never asks for DIRECT_URL in Netlify (migrations run from your own computer) and holds no real secrets', () => {
    expect(assigned.has('DIRECT_URL')).toBe(false);
    expect(template).toMatch(/SESSION_SECRET="CHANGE-ME"/);
    expect(template).not.toMatch(/postgresql:\/\/[^:\s]+:(?!PASSWORD)[^@\s]+@/); // no real password in a connection string
  });
});

describe('repository hygiene', () => {
  it('git ignores secrets, dependencies and build output', () => {
    const ignore = read('.gitignore').split('\n').map((l) => l.trim());
    for (const entry of ['node_modules/', 'dist/', '.env', '.netlify/']) expect(ignore).toContain(entry);
    expect(ignore).toContain('!.env.example');
  });

  it('the CI workflow tests before it can deploy, and keeps secrets out of the file', () => {
    const text = read('.github/workflows/ci.yml');
    const wf = parseYaml(text) as {
      on: { push: { branches: string[] }; pull_request: { branches: string[] } };
      permissions: Record<string, string>;
      jobs: Record<string, { needs?: string; if?: string; steps: Array<{ run?: string; uses?: string }>; services?: Record<string, { image: string }>; env?: Record<string, string> }>;
    };
    expect(wf.on.push.branches).toEqual(['main']);
    expect(wf.on.pull_request.branches).toEqual(['main']);
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(text).not.toContain('pull_request_target');

    const test = wf.jobs.test!;
    expect(test.services!.postgres!.image).toMatch(/^postgres:/);
    const runs = test.steps.map((s) => s.run ?? '');
    for (const needle of ['npm ci', 'prisma generate', 'prisma migrate deploy', 'npm run typecheck', 'npm run build -w @oht/frontend', 'npm test']) {
      expect(runs.some((r) => r.includes(needle)), needle).toBe(true);
    }
    expect(runs.findIndex((r) => r.includes('npm run build'))).toBeLessThan(runs.findIndex((r) => r === 'npm test'));

    const deploy = wf.jobs.deploy!;
    expect(deploy.needs).toBe('test');
    expect(deploy.if).toContain("refs/heads/main");
    expect(deploy.if).toContain('DEPLOY_WITH_ACTIONS');
    expect(deploy.env!.NETLIFY_AUTH_TOKEN).toBe('${{ secrets.NETLIFY_AUTH_TOKEN }}');
    expect(deploy.steps.some((s) => (s.run ?? '').includes('scripts/smoke.mjs'))).toBe(true);
  });
});

describe('Prisma for the Linux runtime', () => {
  it('generates the engine Netlify runs on, and the schema supports pooled and direct connections', () => {
    const schema = read('backend/prisma/schema.prisma');
    expect(schema).toMatch(/binaryTargets\s*=\s*\["native",\s*"rhel-openssl-3\.0\.x"\]/);
    expect(schema).toMatch(/url\s*=\s*env\("DATABASE_URL"\)/);
    expect(schema).toMatch(/directUrl\s*=\s*env\("DIRECT_URL"\)/);
    expect(existsSync(path.join(ROOT, 'node_modules/.prisma/client/libquery_engine-rhel-openssl-3.0.x.so.node'))).toBe(true);
  });
});

describe('the function bundle (built the way Netlify builds it)', () => {
  let dir: string;
  let out: string;
  let code: string;

  beforeAll(async () => {
    mkdirSync(path.join(ROOT, 'node_modules/.cache'), { recursive: true }); // inside the repo so @prisma/client resolves, as on Netlify
    dir = mkdtempSync(path.join(ROOT, 'node_modules/.cache/oht-bundle-'));
    out = path.join(dir, 'api.cjs');
    await build({
      entryPoints: [path.join(ROOT, 'netlify/functions/api.ts')],
      outfile: out,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      external: ['@prisma/client'],
      logLevel: 'silent',
    });
    code = readFileSync(out, 'utf8');
  }, 60_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('bundles without unresolved imports and inlines the workspace engine', () => {
    expect(statSync(out).size).toBeGreaterThan(10_000);
    expect(statSync(out).size).toBeLessThan(6 * 1024 * 1024);
    expect(code).toContain('calculateDailyAttendance'); // @oht/engine is inside the bundle
    expect(code).not.toMatch(/require\("@oht\/engine"\)/);
    expect(code).toMatch(/require\("@prisma\/client"\)/); // Prisma stays external, as configured
    expect(code).not.toMatch(/require\("(express|zod|jose)"\)/); // everything else is inlined
  });

  const REQUIRED = {
    BREVO_API_KEY: 'xkeysib-test',
    EMAIL_FROM: 'sender@example.test',
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    GOOGLE_CLIENT_ID: 'client.apps.googleusercontent.com',
    SESSION_SECRET: 'a-test-secret-that-is-at-least-32-characters-long',
    APP_ORIGIN: 'https://hours.example.test',
    AUTH_MODE: 'google',
  };

  function load(env: Record<string, string | undefined>) {
    const saved = { ...process.env };
    Object.assign(process.env, { DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://x@localhost/x' }, env);
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
    try {
      const req = createRequire(import.meta.url);
      delete req.cache[out];
      return req(out) as { handler: Handler };
    } finally {
      process.env = saved;
    }
  }

  it('starts and serves the health check when configured', async () => {
    const { handler } = load(REQUIRED);
    const res = (await handler(
      { httpMethod: 'GET', path: '/.netlify/functions/api/health', headers: {}, multiValueHeaders: {}, queryStringParameters: null, body: null, isBase64Encoded: false, requestContext: {} } as never,
      {} as Context,
      () => undefined,
    )) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  it('refuses to start when the deployment is misconfigured', () => {
    expect(() => load({ ...REQUIRED, AUTH_MODE: 'dev' })).toThrow(/AUTH_MODE must be "google"/);
    expect(() => load({ ...REQUIRED, SESSION_SECRET: 'short' })).toThrow(/at least 32/);
    expect(() => load({ ...REQUIRED, APP_ORIGIN: undefined })).toThrow(/APP_ORIGIN/);
  });
});

// ---------------------------------------------------------------------------------------------------------
// A local stand-in for Netlify: serves frontend/dist with the headers and routing from netlify.toml, and
// sends /api/* through the real function handler. Then the real smoke script is run against it.
// ---------------------------------------------------------------------------------------------------------

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json' };

interface SiteOptions {
  handler: Handler;
  dropHeaders?: string[];
  noFallback?: boolean;
  skipAssetsRule?: boolean;
}

function startSite({ handler, dropHeaders = [], noFallback = false, skipAssetsRule = false }: SiteOptions): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const url = new URL(req.url ?? '/', 'http://local');
      const pathname = url.pathname;

      // /api/* -> function (the forced redirect in netlify.toml)
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        const splat = pathname.slice('/api/'.length);
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
        const result = (await handler(
          {
            httpMethod: req.method,
            path: `/.netlify/functions/api/${splat}`,
            headers,
            multiValueHeaders: {},
            queryStringParameters: url.search ? Object.fromEntries(url.searchParams) : null,
            body: chunks.length ? Buffer.concat(chunks).toString('utf8') : null,
            isBase64Encoded: false,
            requestContext: {},
          } as never,
          {} as Context,
          () => undefined,
        )) as { statusCode: number; headers?: Record<string, string>; multiValueHeaders?: Record<string, string[]>; body: string };
        const outHeaders: Record<string, string | string[]> = { ...(result.headers ?? {}) };
        for (const [k, v] of Object.entries(result.multiValueHeaders ?? {})) outHeaders[k] = v;
        res.writeHead(result.statusCode, outHeaders);
        res.end(result.body);
        return;
      }

      // static file, else the SPA fallback
      let file = path.join(DIST, pathname === '/' ? 'index.html' : pathname);
      let servedIndex = pathname === '/' || pathname === '/index.html';
      if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
        if (noFallback) {
          res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
          return;
        }
        file = path.join(DIST, 'index.html');
        servedIndex = true;
      }
      const headers: Record<string, string> = {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'public, max-age=0, must-revalidate', // Netlify's default for static files
      };
      for (const rule of toml.headers) {
        const applies = rule.for === '/*' || (rule.for === '/assets/*' && pathname.startsWith('/assets/') && !skipAssetsRule) || (rule.for === '/index.html' && pathname === '/index.html');
        if (applies) for (const [k, v] of Object.entries(rule.values)) if (!dropHeaders.includes(k)) headers[k.toLowerCase()] = v;
      }
      void servedIndex;
      res.writeHead(200, headers);
      res.end(readFileSync(file));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server })));
}

describe('a simulated Netlify site, checked by the real smoke script', () => {
  const prisma = new PrismaClient();
  const email = `deploy-${Date.now()}-${process.pid}@example.test`;
  const ORIGIN = 'https://hours.example.test';
  const verifyGoogle: GoogleVerifier = async () => {
    throw new Error('no real google here');
  };
  let good: Handler;
  const open: Server[] = [];

  beforeAll(async () => {
    if (!existsSync(path.join(DIST, 'index.html'))) execSync('npm run build -w @oht/frontend', { cwd: ROOT, stdio: 'ignore' });
    await seedOwner(prisma, { email, trackingStart: '2026-09-01' });
    good = createHandler(
      { DATABASE_URL: 'x', BREVO_API_KEY: 'k', EMAIL_FROM: 'a@example.test', TURNSTILE_SECRET_KEY: 't', GOOGLE_CLIENT_ID: 'c', SESSION_SECRET: 'a-test-secret-that-is-at-least-32-characters-long', APP_ORIGIN: ORIGIN, AUTH_MODE: 'google' },
      { prisma, verifyGoogle, email: new MemoryEmailSender(), verifyTurnstile: allowAllTurnstile, clock: () => Date.now() },
    );
  }, 200_000);

  afterAll(async () => {
    for (const s of open) s.close();
    await prisma.user.deleteMany({ where: { email } });
    await prisma.$disconnect();
  });

  async function smoke(opts: SiteOptions) {
    const site = await startSite(opts);
    open.push(site.server);
    const report = await runSmoke(site.url, { local: true, origin: ORIGIN });
    const failed = report.results.filter((r: { ok: boolean }) => !r.ok).map((r: { name: string }) => r.name);
    return { report, failed };
  }

  it('a correct deployment passes every check', async () => {
    const { report, failed } = await smoke({ handler: good });
    expect(failed).toEqual([]);
    expect(report.results.length).toBeGreaterThanOrEqual(9);
  });

  it('catches a missing security header', async () => {
    const { failed } = await smoke({ handler: good, dropHeaders: ['Content-Security-Policy'] });
    expect(failed).toEqual(['security headers are present']);
  });

  it('catches deep links that do not fall back to the app', async () => {
    const { failed } = await smoke({ handler: good, noFallback: true });
    expect(failed).toEqual(['deep links load the app (single-page fallback)']);
  });

  it('catches hashed files that are not cached', async () => {
    const { failed } = await smoke({ handler: good, skipAssetsRule: true });
    expect(failed).toEqual(['built files are cached for a long time']);
  });

  it('catches an API that is down', async () => {
    const down = (async () => ({ statusCode: 502, headers: { 'content-type': 'text/plain' }, body: 'Bad Gateway' })) as unknown as Handler;
    const { failed } = await smoke({ handler: down });
    expect(failed).toContain('the API is up and answers quickly');
  });

  it('catches an OPEN API (development sign-in left on), the most dangerous mistake', async () => {
    await seedOwner(prisma, { email, trackingStart: '2026-09-01' });
    const app = createApp({ prisma, clock: () => Date.now(), authenticate: devAuthenticator(prisma, email) });
    const inner = serverless(app) as unknown as Handler;
    const open_: Handler = (event, ctx, cb) => inner({ ...event, path: normalisePath((event as { path: string }).path) }, ctx, cb);
    const { failed } = await smoke({ handler: open_ });
    expect(failed).toContain('private endpoints are locked without sign-in');
  });

  it('catches a site whose allowed origin does not match (sign-in would fail for real users)', async () => {
    const site = await startSite({ handler: good });
    open.push(site.server);
    const report = await runSmoke(site.url, { local: true, origin: 'https://some-other-site.example' });
    const failed = report.results.filter((r: { ok: boolean }) => !r.ok).map((r: { name: string }) => r.name);
    expect(failed).toEqual(['a wrong Google credential is refused cleanly (sign-in is wired up)']);
  });

  it('refuses a non-HTTPS address when not in local mode', async () => {
    const report = await runSmoke('http://example.invalid', { local: false, origin: ORIGIN });
    expect(report.ok).toBe(false);
    expect(report.results[0]).toMatchObject({ name: 'site is served over HTTPS', ok: false });
  });
});
