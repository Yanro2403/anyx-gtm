// Vercel serverless function → GET /api/lotto
//
// Returns the latest Israeli Lotto (מפעל הפיס) draw + next-draw info as JSON.
// Fetches server-side to avoid the browser CORS wall, caches the result, and
// degrades gracefully (returns {ok:false} instead of throwing) so the widget
// on the page can simply stay hidden until real data is available.
//
// VALIDATE ON THE LIVE DEPLOY: pais.co.il is unreachable from the build/dev
// sandbox, so the exact endpoint + format must be confirmed on the live site.
// Set PAIS_RESULTS_URL in the Vercel project env to the verified source, then
// hit /api/lotto?debug=1 to see per-source fetch status and the parsed result.

let CACHE = { at: 0, data: null };
const TTL_MS = 60 * 60 * 1000; // 1h — Lotto draws only ~2×/week

// Candidate sources, tried in order. The env var wins so you can swap the
// verified endpoint without a code change. Add/adjust once validated live.
const SOURCES = [
  process.env.PAIS_RESULTS_URL,
  'https://www.pais.co.il/lotto/lotto_resultsDownload.aspx', // official results file (CSV/Excel)
].filter(Boolean);

const UA =
  'Mozilla/5.0 (compatible; BigSaveBot/1.0; +https://bigsave.example)';

// Israeli Lotto is drawn twice a week — Tuesday and Saturday nights.
const DRAW_DOW = [2, 6]; // 0=Sun … 2=Tue, 6=Sat

function nextDrawISO(fromMs) {
  // naive next Tue/Sat at ~22:00 Israel time; the real date is preferred when
  // the source provides it — this is only a fallback for the countdown.
  const d = new Date(fromMs);
  for (let i = 0; i < 8; i++) {
    const c = new Date(d.getTime() + i * 86400000);
    if (DRAW_DOW.includes(c.getUTCDay())) {
      c.setUTCHours(20, 0, 0, 0); // ~22:00 IL (UTC+2/3) ≈ 20:00 UTC
      if (c.getTime() > fromMs) return c.toISOString();
    }
  }
  return null;
}

// Tolerant parser: works on comma/semicolon/tab CSV. Finds the most recent row
// that carries a draw number, 6 regular numbers, and a strong number.
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
      .map((c) => c.replace(/[^\d.]/g, ''))
      .filter((c) => c !== '')
      .map(Number)
      .filter((n) => Number.isFinite(n));
    // a lotto row has a draw id + 6 regulars (1..37) + strong (1..7)
    const regulars = nums.filter((n) => n >= 1 && n <= 37);
    const strongs = nums.filter((n) => n >= 1 && n <= 7);
    if (nums.length >= 8 && regulars.length >= 6 && strongs.length >= 1) {
      const draw = nums.find((n) => n > 37) || null;
      const dateCell = cells.find((c) => /\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/.test(c)) || null;
      rows.push({
        draw,
        date: dateCell,
        numbers: regulars.slice(0, 6),
        strong: strongs[strongs.length - 1],
      });
    }
  }
  if (!rows.length) return null;
  // results files are usually newest-first or oldest-last; pick the one with
  // the highest draw number to be safe.
  rows.sort((a, b) => (b.draw || 0) - (a.draw || 0));
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
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
      clearTimeout(t);
      attempts.push({ url, status: r.status });
      if (!r.ok) continue;
      const text = await r.text();
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
      attempts.push({ url, note: 'fetched but could not parse a draw row' });
    } catch (e) {
      attempts.push({ url, error: String(e && e.message ? e.message : e) });
    }
  }

  // No live data — return last good cache if we have it, else a clean not-ok.
  if (CACHE.data) return res.status(200).json(CACHE.data);
  return res.status(200).json({
    ok: false,
    reason: 'no source returned parseable data',
    next: { date: nextDrawISO(Date.now()), jackpot: null },
    ...(debug ? { attempts, sources: SOURCES } : {}),
  });
};
