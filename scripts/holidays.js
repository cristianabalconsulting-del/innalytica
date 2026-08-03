// holidays.js — Festividades por país/región desde dos fuentes gratis:
//   - Nager.Date (SIN key): festivos oficiales nacionales.
//   - Calendarific (key CALENDARIFIC_KEY): nacionales + regionales + locales + religiosos.
// Devuelve [{d:'YYYY-MM-DD', city:'', name, festivo:'Si'}] de los próximos 180 días.
// Caché en memoria + DISCO persistente (public/data/_cache_holidays.json) con TTL largo
// (HOLIDAYS_TTL_DAYS, def. 21 días) porque los festivos casi nunca cambian.
const dc = require('./diskcache.js');
const CAL_KEY = process.env.CALENDARIFIC_KEY || '';
const TTL = dc.days(process.env.HOLIDAYS_TTL_DAYS || 21);
const CACHE_FILE = '_cache_holidays.json';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const nagerCache = {};   // year|ISO -> [...]
const calCache = {};     // year|ISO -> [...]
const disk = dc.load(CACHE_FILE);   // 'nager:year|ISO' / 'cal:year|ISO' -> {at, data}
let dirty = false;
let net = false;         // ¿hubo llamada de red en la última operación?

function ymd(dt){ return dt.toISOString().split('T')[0]; }
function years(){ const y = new Date().getFullYear(); return [y, y + 1]; }

async function getJSON(url){
  for (let a = 0; a < 3; a++){
    try { const r = await fetch(url); if (r.status === 429){ await sleep(1200); continue; } if (!r.ok) return null; return await r.json(); }
    catch(e){ return null; }
  }
  return null;
}

async function nager(iso, year){
  const k = year + '|' + iso; if (nagerCache[k]) return nagerCache[k];
  const dk = 'nager:' + k;
  if (dc.fresh(disk[dk], TTL)) { nagerCache[k] = disk[dk].data || []; net = false; return nagerCache[k]; }
  net = true;
  const j = await getJSON('https://date.nager.at/api/v3/PublicHolidays/' + year + '/' + iso);
  const out = Array.isArray(j) ? j.map(function(h){ return { date: h.date, name: h.localName || h.name, global: h.global }; }) : [];
  nagerCache[k] = out;
  disk[dk] = { at: new Date().toISOString(), data: out }; dirty = true;
  return out;
}

async function calendarific(iso, year){
  if (!CAL_KEY) { net = false; return []; }
  const k = year + '|' + iso; if (calCache[k]) return calCache[k];
  const dk = 'cal:' + k;
  if (dc.fresh(disk[dk], TTL)) { calCache[k] = disk[dk].data || []; net = false; return calCache[k]; }
  net = true;
  const j = await getJSON('https://calendarific.com/api/v2/holidays?api_key=' + CAL_KEY + '&country=' + iso + '&year=' + year);
  const hs = (j && j.response && j.response.holidays) || [];
  const out = hs.map(function(h){
    const d = (h.date && h.date.iso ? String(h.date.iso) : '').split('T')[0];
    return { date: d, name: h.name, states: h.states };
  }).filter(function(x){ return x.date; });
  calCache[k] = out;
  disk[dk] = { at: new Date().toISOString(), data: out }; dirty = true;
  return out;
}

function norm(s){ return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }

async function holidaysForGeo(geo){
  const today = new Date(); const start = ymd(today);
  const endDt = new Date(today.getTime() + 180 * 86400000); const end = ymd(endDt);
  const isos = {}; const namesByIso = {};
  (geo || []).forEach(function(g){
    const iso = String(g.iso || '').trim().toUpperCase();
    if (!iso) return;
    isos[iso] = 1;
    (namesByIso[iso] = namesByIso[iso] || []);
    if (g.region) namesByIso[iso].push(norm(g.region));
    if (g.city)   namesByIso[iso].push(norm(g.city));
  });
  const ys = years();
  const merged = []; const seenDate = {};
  for (const iso of Object.keys(isos)){
    const regNames = namesByIso[iso] || [];
    function matchState(states){
      if (states === 'All' || states == null) return true;
      if (!Array.isArray(states)) return true;
      return states.some(function(s){ const sn = norm(s && s.name); return regNames.some(function(r){ return r && (sn.indexOf(r) >= 0 || r.indexOf(sn) >= 0); }); });
    }
    for (const y of ys){
      // Calendarific (rico): nacional + regional/local del cliente
      const cal = await calendarific(iso, y);
      cal.forEach(function(h){
        if (h.date < start || h.date > end) return;
        if (!matchState(h.states)) return;
        const key = h.date + '|' + norm(h.name);
        if (seenDate[key]) return; seenDate[key] = 1;
        merged.push({ d: h.date, city: '', name: h.name, festivo: 'Si' });
      });
      if (net) await sleep(200);
      // Nager (nacional) — agrega solo fechas que no estaban
      const nag = await nager(iso, y);
      nag.forEach(function(h){
        if (h.date < start || h.date > end) return;
        if (h.global === false) return;
        const byDate = merged.some(function(m){ return m.d === h.date; });
        if (byDate) return;
        merged.push({ d: h.date, city: '', name: h.name, festivo: 'Si' });
      });
      if (net) await sleep(150);
    }
  }
  if (dirty) { dc.save(CACHE_FILE, disk); dirty = false; }   // persiste para próximas ejecuciones
  merged.sort(function(a, b){ return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; });
  return merged;
}

module.exports = { holidaysForGeo };
