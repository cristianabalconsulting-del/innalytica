// Genera un JSON por cliente (datos COMPLETOS de Power BI) en public/data/.
// Se ejecuta en GitHub Actions (sin límite de 10s ni de subrequests).
// Reutiliza compute() de la función de Netlify. Variables (secrets) requeridas:
//   AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, PBI_WORKSPACE_ID, PBI_DATASET_ID
const fs = require('fs');
const path = require('path');
const { compute } = require('../netlify/functions/pbi-data.js');

// Lista completa de clientes + la vista agregada (__ALL__ = "Todos")
const CLIENTS = ['AB','A3R','C&B','CAR','CF','CH','CLA','CLM','CYF','CYF2','EDE','ER','FE','GO','HG','HH','HO','HOM','KN','LCH','LH','MAR','MT','OSH','REN','SBS','SCO','SG','ST','URB','VIC','CAT','CAT CORDOBA','CAT PORTO','CAT SAN SEBASTIAN','CEL','CINC','MIN','MIN-2','SAS','SHM','VVB','ICN-ABAL-1668','ICN-ABAL-1740','ICN-ABAL-1799','ICN-ABAL-1835','ICN-ABAL-1847','ICN-ABAL-2377','ICN-ABAL-2628','ICN-ABAL-2667','ICN-ABAL-2936','__ALL__'];

const YEAR = parseInt(process.env.DATA_YEAR) || new Date().getFullYear();
const OUT = path.join(__dirname, '..', 'public', 'data');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fileFor = (c) => c.toUpperCase().replace(/[^A-Za-z0-9_]/g, '_') + '.json';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let ok = 0, fail = 0;
  for (const c of CLIENTS) {
    try {
      const data = await compute(YEAR, c, 0);   // 0 = sin límite de tiempo -> completo
      if (data && data.__complete) {
        fs.writeFileSync(path.join(OUT, fileFor(c)), JSON.stringify(data));
        console.log('OK   ', c, '->', fileFor(c));
        ok++;
      } else {
        console.log('SKIP ', c, '(incompleto, no se sobrescribe)');
        fail++;
      }
    } catch (e) {
      console.log('ERROR', c, e && e.message);
      fail++;
    }
    await sleep(2000);   // respeta el límite de 120 consultas/min de Power BI
  }
  console.log('=== Generación terminada. OK:', ok, 'Fallidos:', fail, '===');
  // marca de última actualización
  try { fs.writeFileSync(path.join(OUT, '_updated.json'), JSON.stringify({ at: new Date().toISOString(), ok, fail })); } catch (e) {}
})();
