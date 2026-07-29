// Shared מפעל הפיס (Israeli Lotto) fetch + parse helpers.
// Used by both the scheduled CI fetcher (scripts/fetch-lotto.js) and the
// live serverless fallback (api/lotto.js).

const SOURCES_DEFAULT = [
  'https://www.pais.co.il/Lotto/lotto_resultsDownload.aspx',
  'https://pais.co.il/Lotto/lotto_resultsDownload.aspx',
];

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'text/csv,application/vnd.ms-excel,text/plain,*/*',
  'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
  Referer: 'https://www.pais.co.il/lotto/',
};

// Israeli Lotto is drawn twice a week — Tuesday and Saturday nights.
const DRAW_DOW = [2, 6]; // 0=Sun … 2=Tue, 6=Sat

function nextDrawISO(fromMs) {
  const d = new Date(fromMs);
  for (let i = 0; i < 8; i++) {
    const c = new Date(d.getTime() + i * 86400000);
    if (DRAW_DOW.includes(c.getUTCDay())) {
      c.setUTCHours(20, 0, 0, 0); // ~22:00 IL ≈ 20:00 UTC
      if (c.getTime() > fromMs) return c.toISOString();
    }
  }
  return null;
}

// Tolerant CSV parser (comma/semicolon/tab). A Lotto row carries a draw number,
// a date, 6 regular numbers (1..37) and a strong number (1..7). We work off the
// digits and ignore Hebrew headers, so the file's encoding is irrelevant.
function parseResults(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const rows = [];
  for (const line of lines) {
    const cells = line
      .split(/[;,\t]/)
      .map((c) => c.trim())
      .filter((c) => c !== '');
    const nums = cells
      .map((c) => c.replace(/[^\d]/g, '')) // "27/07/2026" → "27072026" (excluded below)
      .filter((c) => c !== '')
      .map(Number)
      .filter((n) => Number.isFinite(n));
    const regulars = nums.filter((n) => n >= 1 && n <= 37);
    const strongs = nums.filter((n) => n >= 1 && n <= 7);
    const draw = nums.find((n) => n > 37 && n < 100000); // 2–5 digits, not a ball, not a date
    if (draw && regulars.length >= 6 && strongs.length >= 1) {
      const dateCell =
        cells.find((c) => /\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/.test(c)) || null;
      rows.push({
        draw,
        date: dateCell,
        numbers: regulars.slice(0, 6),
        strong: strongs[strongs.length - 1],
      });
    }
  }
  if (!rows.length) return null;
  rows.sort((a, b) => (b.draw || 0) - (a.draw || 0)); // highest draw # = latest
  return rows[0];
}

async function fetchLatest(opts = {}) {
  const timeoutMs = opts.timeoutMs || 9000;
  const urls = [process.env.PAIS_RESULTS_URL, ...(opts.sources || SOURCES_DEFAULT)].filter(Boolean);
  // Pais blocks cloud/datacenter IPs (Vercel, GitHub Actions). Set PAIS_PROXY
  // (or HTTPS_PROXY) to an Israeli/allowed egress proxy to make requests work
  // from CI or Vercel — no code change needed.
  const proxy = opts.proxy || process.env.PAIS_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy;
  let dispatcher;
  if (proxy) {
    try { dispatcher = new (require('undici').ProxyAgent)(proxy); } catch (e) { /* undici absent */ }
  }
  const attempts = [];
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const r = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: ctrl.signal, ...(dispatcher ? { dispatcher } : {}) });
      clearTimeout(t);
      const text = r.ok ? await r.text() : '';
      attempts.push({ url, status: r.status, bytes: text.length });
      if (!r.ok) continue;
      const parsed = parseResults(text);
      if (parsed && parsed.numbers.length === 6) {
        return {
          ok: true,
          source: url,
          fetchedAt: new Date().toISOString(),
          draw: parsed.draw,
          date: parsed.date,
          numbers: parsed.numbers,
          strong: parsed.strong,
          next: { date: nextDrawISO(Date.now()), jackpot: null },
          attribution: 'מפעל הפיס',
          attempts,
        };
      }
      attempts.push({ url, note: 'fetched but no parseable draw row', sample: text.slice(0, 200) });
    } catch (e) {
      attempts.push({ url, error: String(e && e.message ? e.message : e) });
    }
  }
  return {
    ok: false,
    reason: 'no source returned parseable data',
    next: { date: nextDrawISO(Date.now()), jackpot: null },
    attempts,
  };
}

module.exports = { SOURCES_DEFAULT, HEADERS, nextDrawISO, parseResults, fetchLatest };
