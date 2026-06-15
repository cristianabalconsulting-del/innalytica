// events-tm.js — Eventos reales por ciudad desde Ticketmaster Discovery API (gratis con API key).
// Requiere env TICKETMASTER_KEY. Si no esta, devuelve [] (se conserva el evento del BI).
// Cachea por ciudad dentro de la misma ejecucion. Si la busqueda por ciudad no devuelve nada,
// intenta una busqueda por palabra clave (mejora cobertura en ciudades secundarias).
const KEY = process.env.TICKETMASTER_KEY || '';
const cache = {};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runQuery(extra) {
  const now = new Date();
  const end = new Date(now.getTime() + 180 * 86400000);
  const base = {
    size: '100', sort: 'date,asc',
    startDateTime: now.toISOString().split('.')[0] + 'Z',
    endDateTime: end.toISOString().split('.')[0] + 'Z',
    apikey: KEY
  };
  Object.keys(extra || {}).forEach(function (k) { base[k] = extra[k]; });
  const url = 'https://app.ticketmaster.com/discovery/v2/events.json?' + new URLSearchParams(base).toString();
  let out = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) { await sleep(1300); continue; }
      if (!res.ok) break;
      const j = await res.json();
      const evs = (j && j._embedded && j._embedded.events) || [];
      const seen = {};
      evs.forEach(function (e) {
        const d = e.dates && e.dates.start && e.dates.start.localDate;
        const nm = e.name;
        if (!d || !nm) return;
        const vc = (e._embedded && e._embedded.venues && e._embedded.venues[0] &&
                    e._embedded.venues[0].city && e._embedded.venues[0].city.name) || '';
        const key = d + '|' + nm;
        if (seen[key]) return; seen[key] = 1;
        out.push({ d: d, city: vc, name: nm, festivo: '' });
      });
      break;
    } catch (err) { break; }
  }
  return out;
}

async function fetchCity(city) {
  const k = String(city || '').trim().toLowerCase();
  if (!k) return [];
  if (cache[k]) return cache[k];
  if (!KEY) { cache[k] = []; return []; }
  // 1) por ciudad
  let out = await runQuery({ city: city });
  // 2) si vacio, por palabra clave (mas permisivo) y filtra a la misma ciudad si hay venue
  if (!out.length) {
    await sleep(250);
    const kw = await runQuery({ keyword: city });
    out = kw.filter(function (e) { return !e.city || e.city.toLowerCase().indexOf(k) >= 0 || k.indexOf(e.city.toLowerCase()) >= 0; });
    if (!out.length) out = kw;   // si nada coincide exacto, deja lo que haya
  }
  out.forEach(function (e) { if (!e.city) e.city = city; });
  cache[k] = out;
  return out;
}

async function eventsForCities(cities, maxCities) {
  const uniq = []; const seen = {};
  (cities || []).forEach(function (c) {
    const k = String(c || '').trim().toLowerCase();
    if (k && k !== '?' && k !== '-' && !seen[k]) { seen[k] = 1; uniq.push(c); }
  });
  const list = (maxCities && uniq.length > maxCities) ? uniq.slice(0, maxCities) : uniq;
  let all = [];
  for (const c of list) { const ev = await fetchCity(c); all = all.concat(ev); await sleep(250); }
  const seen2 = {}; const merged = [];
  all.forEach(function (e) { const key = e.d + '|' + e.name; if (!seen2[key]) { seen2[key] = 1; merged.push(e); } });
  merged.sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; });
  return merged;
}

module.exports = { fetchCity, eventsForCities };
