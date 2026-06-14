// Genera un JSON por cliente en public/data/ — SOLO si Power BI tiene un refresco nuevo.
// Corre cada ~30 min en GitHub Actions: detecta el último refresco del dataset y, si es más
// nuevo que la última generación, regenera todo (de noche o intradía). Si no, sale sin gastar nada.
// FORCE=1 (ejecución manual) regenera siempre.
// Secrets: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, PBI_WORKSPACE_ID, PBI_DATASET_ID
const fs = require('fs');
const path = require('path');
const lib = require('../netlify/functions/pbi-data.js');
const { compute } = lib;

const CLIENTS = ['AB','A3R','C&B','CAR','CF','CH','CLA','CLM','CYF','CYF2','EDE','ER','FE','GO','HG','HH','HO','HOM','KN','LCH','LH','MAR','MT','OSH','REN','SBS','SCO','SG','ST','URB','VIC','CAT','CAT CORDOBA','CAT PORTO','CAT SAN SEBASTIAN','CEL','CINC','MIN','MIN-2','SAS','SHM','VVB','ICN-ABAL-1668','ICN-ABAL-1740','ICN-ABAL-1799','ICN-ABAL-1835','ICN-ABAL-1847','ICN-ABAL-2377','ICN-ABAL-2628','ICN-ABAL-2667','ICN-ABAL-2936','__ALL__'];

const YEAR = parseInt(process.env.DATA_YEAR) || new Date().getFullYear();
const OUT  = path.join(__dirname, '..', 'public', 'data');
const FORCE = process.env.FORCE === '1';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fileFor = (c) => c.toUpperCase().replace(/[^A-Za-z0-9_]/g, '_') + '.json';

// Última hora de refresco del dataset en Power BI (REST). Devuelve ms (0 si no se puede leer).
async function getLastRefresh() {
  const token = await lib.getToken();
  const ws = process.env.PBI_WORKSPACE_ID, ds = process.env.PBI_DATASET_ID;
  const res = await fetch(`https://api.powerbi.com/v1.0/myorg/groups/${ws}/datasets/${ds}/refreshes?$top=1`,
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
    if (data && data.__complete) { fs.writeFileSync(path.join(OUT, fileFor(c)), JSON.stringify(data)); console.log('OK   ', c); return true; }
    console.log('INCOMPLETO', c); return false;
  } catch (e) { console.log('ERROR', c, e && e.message); return false; }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(path.join(OUT, '_updated.json'), 'utf8')); } catch (e) {}
  let pbiRefresh = 0;
  try { pbiRefresh = await getLastRefresh(); console.log('Último refresco PBI:', pbiRefresh ? new Date(pbiRefresh).toISOString() : '(desconocido)'); }
  catch (e) { console.log('No se pudo leer el refresco de PBI:', e.message); }

  if (!FORCE) {
    if (pbiRefresh && prev.pbiRefresh && pbiRefresh <= prev.pbiRefresh) {
      console.log('No hay refresco nuevo de Power BI. Salgo sin regenerar.'); return;
    }
    if (!pbiRefresh && prev.at && (Date.now() - Date.parse(prev.at) < 6 * 3600 * 1000)) {
      console.log('Sin info de refresco y última generación hace <6h. Salgo.'); return;
    }
  }
  console.log(FORCE ? 'Forzado: regenerando todo.' : 'Hay datos nuevos: regenerando todo.');

  let pending = CLIENTS.slice();
  for (let pasada = 1; pasada <= 4 && pending.length; pasada++) {
    console.log('=== Pasada ' + pasada + ' — ' + pending.length + ' clientes ===');
    const fallidos = [];
    for (const c of pending) { const ok = await tryOne(c); if (!ok) fallidos.push(c); await sleep(3500); }
    pending = fallidos;
    if (pending.length) { console.log('Reintento próxima pasada:', pending.join(', ')); await sleep(30000); }
  }
  const total = CLIENTS.length, fail = pending.length, ok = total - fail;
  console.log('=== FIN. OK:', ok, 'Fallidos:', fail, '===');
  fs.writeFileSync(path.join(OUT, '_updated.json'), JSON.stringify({ at: new Date().toISOString(), pbiRefresh, ok, fail, fallidos: pending }));
})();
