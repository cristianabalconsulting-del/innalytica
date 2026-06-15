// Genera un JSON por cliente en public/data/.
// Secrets: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, PBI_WORKSPACE_ID, PBI_DATASET_ID
// Opcional: TICKETMASTER_KEY, CALENDARIFIC_KEY (eventos + festividades web por ciudad/pais).
const fs = require('fs');
const path = require('path');
const lib = require('../netlify/functions/pbi-data.js');
const { compute } = lib;
const tm  = require('./events-tm.js');   // eventos (Ticketmaster)
const hol = require('./holidays.js');    // festividades (Nager + Calendarific)

const FULL = ['AB','A3R','C&B','CAR','CF','CH','CLA','CLM','CYF','CYF2','EDE','ER','FE','GO','HG','HH','HO','HOM','KN','LCH','LH','MAR','MT','OSH','REN','SBS','SCO','SG','ST','URB','VIC','CAT','CAT CORDOBA','CAT PORTO','CAT SAN SEBASTIAN','CEL','CINC','MIN','MIN-2','SAS','SHM','VVB','ICN-ABAL-1668','ICN-ABAL-1740','ICN-ABAL-1799','ICN-ABAL-1835','ICN-ABAL-1847','ICN-ABAL-2377','ICN-ABAL-2628','ICN-ABAL-2667','ICN-ABAL-2936'];
const HEAVY = ['MIN','CYF2','CLA','ICN-ABAL-1668','ICN-ABAL-1740','ICN-ABAL-1799','ICN-ABAL-1835','ICN-ABAL-1847','ICN-ABAL-2377','ICN-ABAL-2628','ICN-ABAL-2667','ICN-ABAL-2936'];
function pickClients(){
  if (process.env.CLIENTS) return process.env.CLIENTS.split(',').map(function(x){return x.trim();}).filter(Boolean);
  const g = (process.env.GROUP || 'all').toLowerCase();
  if (g === 'fast')  return FULL.filter(function(c){return HEAVY.indexOf(c) < 0;});
  if (g === 'heavy') return HEAVY.concat(['__ALL__']);
  return FULL.concat(['__ALL__']);
}
const CLIENTS = pickClients();
console.log('Clientes a generar:', CLIENTS.join(', '));

const YEAR = parseInt(process.env.DATA_YEAR) || new Date().getFullYear();
const OUT  = path.join(__dirname, '..', 'public', 'data');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fileFor = (c) => c.toUpperCase().replace(/[^A-Za-z0-9_]/g, '_') + '.json';

async function getLastRefresh() {
  const token = await lib.getToken();
  const ws = process.env.PBI_WORKSPACE_ID, ds = process.env.PBI_DATASET_ID;
  const res = await fetch('https://api.powerbi.com/v1.0/myorg/groups/' + ws + '/datasets/' + ds + '/refreshes?$top=1',
                         { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('refreshes HTTP ' + res.status);
  const j = await res.json();
  const r = j && j.value && j.value[0];
  const t = r && (r.endTime || r.startTime);
  return t ? Date.parse(t) : 0;
}

async function tryOne(c) {
  try {
    const data = await compute(YEAR, c, 0);
    if (data && data.__complete) {
      try {
        if (c !== '__ALL__') {
          const geo = data.geo || [];
          const cities = []; const seenC = {};
          geo.forEach(function (g) { const l = g && g.city; if (l && !seenC[l]) { seenC[l] = 1; cities.push(l); } });
          if (!cities.length) (data.salesDim || []).forEach(function (r) { const l = r && r.loc; if (l && l !== '?' && !seenC[l]) { seenC[l] = 1; cities.push(l); } });
          let extra = [];
          if (process.env.TICKETMASTER_KEY) { try { extra = extra.concat(await tm.eventsForCities(cities, 12) || []); } catch (e) {} }
          try { extra = extra.concat(await hol.holidaysForGeo(geo) || []); } catch (e) {}
          if (extra.length) {
            const seen2 = {}; const merged = [];
            extra.forEach(function (e) { const k = e.d + '|' + e.name; if (e.d && e.name && !seen2[k]) { seen2[k] = 1; merged.push(e); } });
            merged.sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; });
            data.eventos = merged;
          }
        }
      } catch (e) { console.log('  (eventos web omitidos para ' + c + ':', e && e.message, ')'); }
      data.__generatedAt = new Date().toISOString();
      fs.writeFileSync(path.join(OUT, fileFor(c)), JSON.stringify(data));
      console.log('OK   ', c, (data.eventos && data.eventos.length ? '· ' + data.eventos.length + ' eventos' : ''));
      return true;
    }
    console.log('INCOMPLETO', c); return false;
  } catch (e) { console.log('ERROR', c, e && e.message); return false; }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let pbiRefresh = 0;
  try { pbiRefresh = await getLastRefresh(); } catch (e) {}
  console.log('Regenerando todos los clientes (horario fijo o manual)...');
  let pending = CLIENTS.slice();
  for (let pasada = 1; pasada <= 4 && pending.length; pasada++) {
    console.log('=== Pasada ' + pasada + ' — ' + pending.length + ' clientes ===');
    const fallidos = [];
    for (const c of pending) { const ok = await tryOne(c); if (!ok) fallidos.push(c); await sleep(3500); }
    pending = fallidos;
    if (pending.length) { console.log('Reintento proxima pasada:', pending.join(', ')); await sleep(30000); }
  }
  const total = CLIENTS.length, fail = pending.length, ok = total - fail;
  console.log('=== FIN. OK:', ok, 'Fallidos:', fail, '===');
  fs.writeFileSync(path.join(OUT, '_updated.json'), JSON.stringify({ at: new Date().toISOString(), pbiRefresh, ok, fail, fallidos: pending }));
})();
