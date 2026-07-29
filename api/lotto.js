// Vercel serverless function → GET /api/lotto
//
// LIVE FALLBACK only. The primary data path is the committed lotto.json
// (produced by the scheduled GitHub Action, which can reach pais.co.il) — the
// page reads /lotto.json first and only calls this if that's missing/invalid.
// This tries Pais live; note Pais tends to block Vercel's datacenter IPs, so
// this may return {ok:false} — that's fine, the widget just stays hidden.
//
// /api/lotto?debug=1 returns per-source fetch attempts for diagnostics.

const { fetchLatest } = require('../lib/pais');

let CACHE = { at: 0, data: null };
const TTL_MS = 60 * 60 * 1000;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  const debug = req.query && (req.query.debug === '1' || req.query.debug === 'true');

  if (!debug && CACHE.data && Date.now() - CACHE.at < TTL_MS) {
    return res.status(200).json(CACHE.data);
  }

  const data = await fetchLatest();
  if (data.ok) CACHE = { at: Date.now(), data };

  if (debug) return res.status(200).json(data);
  if (data.ok) return res.status(200).json(data);
  if (CACHE.data) return res.status(200).json(CACHE.data);
  return res.status(200).json({ ok: false, reason: data.reason, next: data.next });
};
