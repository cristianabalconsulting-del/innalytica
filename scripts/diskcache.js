// diskcache.js — Caché PERSISTENTE en disco (sobrevive entre ejecuciones de GitHub Actions
// porque el fichero se commitea junto con public/data). Lo usan events-tm.js y holidays.js
// para NO volver a pedir a las APIs lo que ya se pidió hace poco (eventos/festivos cambian lento).
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'public', 'data');

function load(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')) || {}; }
  catch (e) { return {}; }
}
function save(file, obj) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, file), JSON.stringify(obj)); }
  catch (e) { /* si falla el guardado, seguimos: la caché es opcional */ }
}
// fresca si la entrada tiene 'at' y su antigüedad es menor que ttlMs
function fresh(entry, ttlMs) {
  return !!(entry && entry.at && (Date.now() - Date.parse(entry.at) < ttlMs));

