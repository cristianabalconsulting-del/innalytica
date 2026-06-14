// Genera un JSON por cliente (datos COMPLETOS de Power BI) en public/data/.
// Corre en GitHub Actions (sin límite de 10s ni de subrequests).
// Reintenta los clientes que fallan (por el límite de 120 consultas/min) en varias pasadas.
// Secrets requeridos: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, PBI_WORKSPACE_ID, PBI_DATASET_ID
const fs = require('fs');
const path = require('path');
const { compute } = require('../netlify/functions/pbi-data.js');

const CLIENTS = ['AB','A3R','C&B','CAR','CF','CH','CLA','CLM','CYF','CYF2','EDE','ER','FE','GO','HG','HH','HO','HOM','KN','LCH','LH','MAR','MT','OSH','REN','SBS','SCO','SG','ST','URB','VIC','CAT','CAT CORDOBA','CAT PORTO','CAT SAN SEBASTIAN','CEL','CINC','MIN','MIN-2','SAS','SHM','VVB','ICN-ABAL-1668','ICN-ABAL-1740','ICN-ABAL-1799','ICN-ABAL-1835','ICN-ABAL-1847','ICN-ABAL-2377','ICN-ABAL-2628','ICN-ABAL-2667','ICN-ABAL-2936','__ALL__'];

const YEAR = parseInt(process.env.DATA_YEAR) || new Date().getFullYear();
const OUT  = path.join(__dirname, '..', 'public', 'data');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fileFor = (c) => c.toUpperCase().replace(/[^A-Za-z0-9_]/g, '_') + '.json';

async function tryOne(c) {
  try {
    const data = await compute(YEAR, c, 0);   // 0 = sin límite -> completo
    if (data && data.__complete) {
      fs.writeFileSync(path.join(OUT, fileFor(c)), JSON.stringify(data));
      console.log('OK   ', c);
      return true;
    }
    console.log('INCOMPLETO', c);
    return false;
  } catch (e) {
    console.log('ERROR', c, e && e.message);
    return false;
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let pending = CLIENTS.slice();
  const MAX_PASADAS = 4;
  for (let pasada = 1; pasada <= MAX_PASADAS && pending.length; pasada++) {
    console.log('=== Pasada ' + pasada + ' — ' + pending.length + ' clientes ===');
    const fallidos = [];
    for (const c of pending) {
      const ok = await tryOne(c);
      if (!ok) fallidos.push(c);
      await sleep(3500);   // suave: respeta el límite de 120 consultas/min
    }
    pending = fallidos;
    if (pending.length) {
      console.log('Reintentar en próxima pasada:', pending.join(', '));
      await sleep(30000);  // deja respirar a Power BI antes de reintentar
    }
  }
  const total = CLIENTS.length, fail = pending.length, ok = total - fail;
  console.log('=== FIN. OK:', ok, 'Fallidos:', fail, (fail ? '(' + pending.join(', ') + ')' : ''), '===');
  try { fs.writeFileSync(path.join(OUT, '_updated.json'), JSON.stringify({ at: new Date().toISOString(), ok, fail, fallidos: pending })); } catch (e) {}
})();
