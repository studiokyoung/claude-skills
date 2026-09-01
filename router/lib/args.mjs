// ~/claude-skills/router/lib/args.mjs
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const key = t.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

export function safeJson(s) {
  if (typeof s !== 'string') return null;
  try { return JSON.parse(s); } catch { return null; }
}
