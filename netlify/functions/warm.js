// Función PROGRAMADA (cron en netlify.toml, cada 10 min): precalienta la caché compartida
// COMPLETA de los clientes, ROTANDO por tandas para no saturar Power BI.
// - WARM_CLIENTS  = lista completa de clientes separados por coma.
// - WARM_BATCH    = cuántos por ciclo (por defecto 8). Recorre toda la lista en varias vueltas.
// Cada cliente precalentado queda COMPLETO en caché (el background no tiene límite de tiempo).
exports.handler = async function () {
  
  const all = (process.env.WARM_CLIENTS || 'AB').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  const batchSize = Math.max(1, parseInt(process.env.WARM_BATCH) || 8);
  const batches = Math.max(1, Math.ceil(all.length / batchSize));
  const idx = Math.floor(Date.now() / 600000) % batches;          // rota una tanda cada 10 min
 
  for (const a of targets) {
    try {
      const r = await fetch(base + '/.netlify/functions/pbi-data-background?year=' + year +
                            '&alojamiento=' + encodeURIComponent(a));
      res.push(a + ':' + r.status);
    } catch (e) { res.push(a + ':err'); }
  }
  return { statusCode: 200, body: JSON.stringify({ tanda: (idx + 1) + '/' + batches, total: all.length, targets: targets, res: res }) };
};
