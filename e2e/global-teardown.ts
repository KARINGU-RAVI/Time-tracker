export default async function globalTeardown() {
  const base = `http://127.0.0.1:${process.env.E2E_PORT ?? 4599}`;
  await fetch(`${base}/__test/cleanup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefix: 'e2e-' }) });
  await fetch(`${base}/__test/clock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ iso: null }) });
}
