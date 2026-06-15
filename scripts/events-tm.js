// events-tm.js — Eventos reales por ciudad desde Ticketmaster Discovery API (gratis con API key).
// Requiere env TICKETMASTER_KEY. Si no está, devuelve [] (se conserva el evento del BI).
// Cachea por ciudad dentro de la misma ejecución para no repetir llamadas.
const KEY = process.env.TICKETMASTER_KEY || '';
const cache = {};                 // ciudad(min) -> [{d,city,name,festivo}]
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchCity(city) {
  const k = String(city || '').trim().toLowerCase();
  if (!k) return [];
  if (cache[k]) return cache[k];
  if (!KEY) { cache[k] = []; return []; }
  const now = new Date();
  const end = new Date(now.getTime() + 180 * 86400000);
  const params = new URLSearchParams({
    city: city, size: '80', sort: 'date,asc',
    startDateTime: now.toISOString().split('.')[0] + 'Z',
    endDateTime: end.toISOString().split('.')[0] + 'Z',
    apikey: KEY
  });
  const url = 'https://app.ticketmaster.com/discovery/v2/events.json?' + params.toString();
  let out = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) { await sleep(1300); continue; }   // rate limit
      if (!res.ok) break;
      const j = await res.json();
      const evs = (j && j._embedded && j._embedded.events) || [];
      const seen = {};
      evs.forEach(function (e) {
        const d = e.dates && e.dates.start && e.dates.start.localDate;
        const nm = e.name;
        if (!d || !nm) return;
        const vc = (e._embedded && e._embedded.venues && e._embedded.venues[0] &&
                    e._embedded.venues[0].city && e._embedded.venues[0].city.name) || city;
        const key = d + '|' + nm;
        if (seen[key]) return; seen[key] = 1;
        out.push({ d: d, city: vc, name: nm, festivo: '' });
      });
      break;
    } catch (err) { break; }
  }
  cache[k] = out;
  return out;
}

// Eventos combinados (dedup por fecha+nombre, ordenados) para una lista de ciudades.
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
  all.forEach(function (e) { const k = e.d + '|' + e.name; if (!seen2[k]) { seen2[k] = 1; merged.push(e); } });
  merged.sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; });
  return merged;
}

module.exports = { fetchCity, eventsForCities };
