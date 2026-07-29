// Vercel serverless function → GET /api/lotto
//
// Returns the latest Israeli Lotto (מפעל הפיס) draw + next-draw info as JSON.
// Fetches server-side to avoid the browser CORS wall, caches the result, and
// degrades to {ok:false} instead of throwing so the page widget can simply
// stay hidden until real data is available.
//
// Source: the official Lotto results file (used by many community projects):
//   https://www.pais.co.il/Lotto/lotto_resultsDownload.aspx
// It requires realistic browser headers (Referer + Accept-Language) or the
// server hangs. Override the URL via PAIS_RESULTS_URL and inspect
// /api/lotto?debug=1 for per-source fetch status when validating live.

let CACHE = { at: 0, data: null };
const TTL_MS = 60 * 60 * 1000; // 1h — Lotto draws only ~2×/week
const FETCH_TIMEOUT_MS = 9000; // stay under Vercel's function limit

const SOURCES = [
  process.env.PAIS_RESULTS_URL,
  'https://www.pais.co.il/Lotto/lotto_resultsDownload.aspx',
  'https://pais.co.il/Lotto/lotto_resultsDownload.aspx',
].filter(Boolean);

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

// Tolerant parser for the results CSV (comma/semicolon/tab separated).
// A Lotto row carries: draw number, date, 6 regular numbers (1..37) and a
// strong number (1..7). We ignore Hebrew headers/columns entirely and work
// off the digits, so encoding (the file is Hebrew/Windows-1255) is irrelevant.
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
    // strip non-digits per cell → a date cell like "27/07/2026" collapses to
    // one big 8-digit number (excluded below), never polluting the balls.
    const nums = cells
      .map((c) => c.replace(/[^\d]/g, ''))
      .filter((c) => c !== '')
      .map(Number)
      .filter((n) => Number.isFinite(n));
    const regulars = nums.filter((n) => n >= 1 && n <= 37);
    const strongs = nums.filter((n) => n >= 1 && n <= 7);
    // draw id: 2–5 digits, above the ball range and below a collapsed date.
    const draw = nums.find((n) => n > 37 && n < 100000);
    if (draw && regulars.length >= 6 && strongs.length >= 1) {
      const dateCell =
        cells.find((c) => /\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/.test(c)) || null;
      rows.push({
        draw,
        date: dateCell,
        numbers: regulars.slice(0, 6),
        strong: strongs[strongs.length - 1], // strong is the last small number in the row
      });
    }
  }
  if (!rows.length) return null;
  rows.sort((a, b) => (b.draw || 0) - (a.draw || 0)); // highest draw # = latest
  return rows[0];
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  const debug = req.query && (req.query.debug === '1' || req.query.debug === 'true');

  if (!debug && CACHE.data && Date.now() - CACHE.at < TTL_MS) {
    return res.status(200).json(CACHE.data);
  }

  const attempts = [];
  for (const url of SOURCES) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      const r = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: ctrl.signal });
      clearTimeout(t);
      const text = r.ok ? await r.text() : '';
      attempts.push({ url, status: r.status, bytes: text.length });
      if (!r.ok) continue;
      const parsed = parseResults(text);
      if (parsed && parsed.numbers.length === 6) {
        const data = {
          ok: true,
          source: url,
          fetchedAt: new Date().toISOString(),
          draw: parsed.draw,
          date: parsed.date,
          numbers: parsed.numbers,
          strong: parsed.strong,
          next: { date: nextDrawISO(Date.now()), jackpot: null },
          attribution: 'מפעל הפיס',
        };
        CACHE = { at: Date.now(), data };
        return res.status(200).json(debug ? { ...data, attempts } : data);
      }
      attempts.push({ url, note: 'fetched but no parseable draw row', sample: text.slice(0, 200) });
    } catch (e) {
      attempts.push({ url, error: String(e && e.message ? e.message : e) });
    }
  }

  if (CACHE.data) return res.status(200).json(CACHE.data);
  return res.status(200).json({
    ok: false,
    reason: 'no source returned parseable data',
    next: { date: nextDrawISO(Date.now()), jackpot: null },
    ...(debug ? { attempts, sources: SOURCES } : {}),
  });
};
