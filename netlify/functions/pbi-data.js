// FUNCIÓN BACKGROUND (sufijo -background): se ejecuta de forma asíncrona hasta 15 min,
// sin el límite de tiempo normal. Calcula el dataset COMPLETO de un cliente y lo deja
// en la caché compartida (Blobs). El endpoint en vivo (pbi-data) sirve luego ese completo.
// Requiere plan de Netlify con Background Functions.
const lib = require('./pbi-data.js');
exports.handler = async function (event) {
  const year = parseInt(event.queryStringParameters && event.queryStringParameters.year) || new Date().getFullYear();
  const aloj = String((event.queryStringParameters && event.queryStringParameters.alojamiento) || 'AB')
                 .replace(/[^A-Za-z0-9&\-_ |]/g, '').slice(0, 800) || 'AB';
  try {
    const d = await lib.warmClient(year, aloj);
    console.log('[warm-bg]', aloj, 'complete=', d.__complete);
    return { statusCode: 200, body: JSON.stringify({ ok: true, aloj: aloj, complete: !!d.__complete }) };
  } catch (e) {
    console.error('[warm-bg] error', aloj, e.message);
    return { statusCode: 500, body: String(e.message || e) };
  }
};
