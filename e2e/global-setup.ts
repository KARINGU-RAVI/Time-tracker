/** Clears anything a crashed earlier run left behind (only accounts whose address starts with "e2e-"). */
export default async function globalSetup() {
  const base = `http://127.0.0.1:${process.env.E2E_PORT ?? 4599}`;
  await fetch(`${base}/__test/cleanup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefix: 'e2e-' }) });
}
