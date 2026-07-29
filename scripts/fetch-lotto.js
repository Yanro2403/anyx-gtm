#!/usr/bin/env node
// Scheduled fetcher (runs in GitHub Actions where it can reach pais.co.il).
// Writes lotto.json ONLY on success, so a failed/blocked fetch never
// overwrites the last known-good data.

const fs = require('fs');
const path = require('path');
const { fetchLatest } = require('../lib/pais');

(async () => {
  const data = await fetchLatest({ timeoutMs: 20000 }); // CI has no 10s limit
  if (!data.ok || !(data.numbers && data.numbers.length === 6)) {
    console.error('Lotto fetch failed — keeping existing lotto.json.');
    console.error(JSON.stringify(data.attempts || data.reason, null, 2));
    process.exit(1);
  }
  const out = {
    ok: true,
    draw: data.draw,
    date: data.date,
    numbers: data.numbers,
    strong: data.strong,
    next: data.next,
    attribution: data.attribution,
    source: data.source,
    fetchedAt: data.fetchedAt,
  };
  const file = path.join(__dirname, '..', 'lotto.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log('Wrote lotto.json — draw', out.draw, out.numbers.join('-'), '+', out.strong);
})();
