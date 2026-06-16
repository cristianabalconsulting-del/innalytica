// ═══════════════════════════════════════════════════════════════════
// Netlify Function: pbi-data.js
// Proxy seguro entre el front-end y Power BI / Azure AD
// El token y el secreto nunca llegan al navegador
// ═══════════════════════════════════════════════════════════════════

const TENANT_ID   = process.env.AZURE_TENANT_ID;
const CLIENT_ID   = process.env.AZURE_CLIENT_ID;
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;
const WORKSPACE_ID  = process.env.PBI_WORKSPACE_ID;   // 650d8d68-0c99-4684-89e7-59d80978db30
const DATASET_ID    = process.env.PBI_DATASET_ID;     // 174a154d-a484-48c9-9023-7c71bae578e8

// ── Estado a nivel de módulo (se reutiliza entre invocaciones "warm") ──
const RESP_TTL_MS   = 300000;   // 5 min de caché de respuesta por (alojamiento, año)
const QUERY_TIMEOUT = parseInt(process.env.QUERY_TIMEOUT_MS) || 12000;  // configurable (la generación usa más)
const POOL_SIZE     = parseInt(process.env.POOL_SIZE) || 14;  // configurable (generación usa pool bajo)
const BUDGET_MS     = parseInt(process.env.PBI_BUDGET_MS) || 7500;  // cabe en el límite de 10s de Free
const ESSENTIAL     = {kpi:1,ytdToday:1,mesActual:1,dp26:1,dp25:1,capDim:1,unitsCount:1,dpChan26:1,dpChan25:1,pace26:1,pace25:1,paceLead:1}; // se piden primero
let   TOKEN_CACHE   = { token: null, exp: 0 };
let   TOKEN_PROMISE = null;     // dedup de peticiones de token concurrentes
const RESP_CACHE    = new Map(); // key `${aloj}|${year}` -> { exp, promise }
const RESP_STALE    = new Map(); // último resultado bueno por clave (fallback ante fallo)
const BLOB_TTL_MS   = 28800000; // 8h (recalcula al expirar para recoger el refresco diario)
let   _blobStore    = undefined;
async function _store(){
  if (_blobStore !== undefined) return _blobStore;
  try {
    const m = await import('@netlify/blobs');
    const opts = { name: 'pbi-cache' };
    const sid = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const tok = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
    if (sid && tok) { opts.siteID = sid; opts.token = tok; }   // config manual si el auto-contexto falla
    _blobStore = m.getStore(opts);
    console.log('[blobs] OK (caché compartida activa)');
  } catch (e) { _blobStore = null; console.error('[blobs] NO DISPONIBLE -> sin caché:', e.message); }
  return _blobStore;
}
async function blobGet(key){ try { const st = await _store(); if(!st) return null; return (await st.get(key,{type:'json'}))||null; } catch(e){ return null; } }
async function blobSet(key,val){ try { const st = await _store(); if(!st) return; await st.setJSON(key,val); } catch(e){} }
// Última hora de refresco REAL del dataset en Power BI (REST refresh history).
// Así recalculamos exactamente cuando PBI se actualiza (2am, 3am o intradía), no a hora fija.
let REFRESH_CHECK = { ms: 0, exp: 0 };
async function getLastRefreshMs(token){
  if (REFRESH_CHECK.exp > Date.now()) return REFRESH_CHECK.ms;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);   // nunca bloquea más de 3s
    const url = `https://api.powerbi.com/v1.0/myorg/groups/${WORKSPACE_ID}/datasets/${DATASET_ID}/refreshes?$top=1`;
    let res;
    try { res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
    if (res && res.ok) {
      const j = await res.json();
      const r = j && j.value && j.value[0];
      const t = r && (r.endTime || r.startTime);
      const ms = t ? Date.parse(t) : 0;
      REFRESH_CHECK = { ms: ms || REFRESH_CHECK.ms, exp: Date.now() + 300000 };
      return REFRESH_CHECK.ms;
    }
  } catch (e) {}
  REFRESH_CHECK = { ms: REFRESH_CHECK.ms, exp: Date.now() + 300000 };  // si falla/tarda -> sigue sin bloquear
  return REFRESH_CHECK.ms;
}


// ── Obtener token de Azure AD (Client Credentials) ──────────────────
async function getToken() {
  const now = Date.now();
  if (TOKEN_CACHE.token && TOKEN_CACHE.exp > now) return TOKEN_CACHE.token;
  if (TOKEN_PROMISE) return TOKEN_PROMISE;          // otra invocación ya lo está pidiendo
  TOKEN_PROMISE = _fetchToken().then(t => { TOKEN_PROMISE = null; return t; })
                               .catch(e => { TOKEN_PROMISE = null; throw e; });
  return TOKEN_PROMISE;
}

async function _fetchToken() {
  const url = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope:         'https://analysis.windows.net/powerbi/api/.default'
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token error ${res.status}: ${err}`);
  }

  const data = await res.json();
  // cachea ~5 min antes de expirar
  const ttl = ((parseInt(data.expires_in) || 3600) - 300) * 1000;
  TOKEN_CACHE = { token: data.access_token, exp: Date.now() + Math.max(60000, ttl) };
  return data.access_token;
}

// ── Ejecutar query DAX ───────────────────────────────────────────────
function _sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// Espaciador global opcional (para la generación masiva): limita el ritmo de consultas
// y así no chocar con el límite de Power BI (120/min). 0 = sin límite (función en vivo).
const QUERY_SPACING_MS = parseInt(process.env.QUERY_SPACING_MS) || 0;
let _nextSlot = 0;
let _pauseUntil = 0;   // pausa global tras un 429 (Power BI pide esperar)
async function _gate(){
  // respeta una pausa global si Power BI nos frenó
  while(_pauseUntil > Date.now()){ await _sleep(Math.min(3000, _pauseUntil - Date.now())); }
  if(!QUERY_SPACING_MS) return;
  const now = Date.now();
  const slot = Math.max(now, _nextSlot);
  _nextSlot = slot + QUERY_SPACING_MS;
  const wait = slot - now;
  if(wait>0) await _sleep(wait);
}
async function daxQuery(token, query, attempt, deadline) {
  attempt = attempt || 0;
  await _gate();
  const url = `https://api.powerbi.com/v1.0/myorg/groups/${WORKSPACE_ID}/datasets/${DATASET_ID}/executeQueries`;
  const budget = deadline ? (deadline - Date.now()) : QUERY_TIMEOUT;
  if (deadline && budget <= 250) throw new Error('deadline');           // sin tiempo: no la intentes
  const perTimeout = Math.max(800, Math.min(QUERY_TIMEOUT, budget));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), perTimeout);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries: [{ query }] }),
      signal: ctrl.signal
    });
    if (!res.ok) {
      const err = await res.text();
      // 429 (throttling) o 5xx: pausa GLOBAL el tiempo que pida PBI y reintenta
      if ((res.status === 429 || res.status >= 500) && attempt < 6 && (!deadline || Date.now() < deadline - 1200)) {
        let secs = parseInt(res.headers.get('Retry-After')) || 0;
        if (!secs) { const m = String(err).match(/Retry in (\d+)\s*second/i); if (m) secs = parseInt(m[1]); }
        if (!secs) secs = (res.status === 429 ? 30 : 5);
        _pauseUntil = Math.max(_pauseUntil, Date.now() + secs * 1000 + 500);  // frena TODO el pipeline
        clearTimeout(timer);
        await _sleep(300);
        return daxQuery(token, query, attempt + 1, deadline);
      }
      throw new Error(`DAX ${res.status}: ${err.slice(0,160)}`);
    }
    const data = await res.json();
    if (data.error) throw new Error(`DAX: ${data.error.code}`);
    return data?.results?.[0]?.tables?.[0]?.rows || [];
  } catch (e) {
    if ((e.name === 'AbortError') && attempt < 1 && (!deadline || Date.now() < deadline - 1500)) {
      clearTimeout(timer);
      return daxQuery(token, query, attempt + 1, deadline);  // un reintento si hubo timeout y queda presupuesto
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Ejecuta todas las queries con límite de concurrencia; un fallo NO tumba el resto
async function runQueries(token, queries, deadline) {
  // Esenciales primero (Overview/charts) -> garantiza que carguen aunque el detalle no dé tiempo
  const keys = Object.keys(queries).sort((a,b) => (ESSENTIAL[b]?1:0) - (ESSENTIAL[a]?1:0));
  const entries = keys.map(k => ({ key: k, q: queries[k] }));
  const out = {};
  let idx = 0;
  async function worker() {
    while (idx < entries.length) {
      const e = entries[idx++];
      if (deadline && Date.now() >= deadline) { out[e.key] = []; continue; }  // fuera de presupuesto -> vacío (parcial)
      try { out[e.key] = await daxQuery(token, e.q, 0, deadline); }
      catch (err) { console.error('[query KO]', e.key, err.message); out[e.key] = []; }
    }
  }
  let dropped = 0;
  const _origWorker = worker;
  // re-define worker para contar descartes (deadline) y errores
  async function worker2() {
    while (idx < entries.length) {
      const e = entries[idx++];
      if (deadline && Date.now() >= deadline) { out[e.key] = []; dropped++; continue; }
      try { out[e.key] = await daxQuery(token, e.q, 0, deadline); }
      catch (err) { console.error('[query KO]', e.key, err.message); out[e.key] = []; dropped++; }
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(POOL_SIZE, entries.length); i++) workers.push(worker2());
  await Promise.all(workers);
  return { out: out, dropped: dropped };
}

// ── Queries DAX exactas (mismo modelo verificado) ────────────────────
function buildQueries(year, aloj) {
  const prevYear = year - 1;
  // alojamiento puede ser uno o varios (separados por '|'); se agregan con IN {...}.
  // '__ALL__' = todos (vista portfolio) -> modo ligero.
  const ALL_ALOJ = ['A3R','AB','C&B','CAR','CF','CH','CLA','CLM','CYF','CYF2','EDE','ER','FE','GO','HG','HH','HO','HOM','KN','LCH','LH','MAR','MT','OSH','REN','SBS','SCO','SG','ST','URB','VIC','CAT','CAT CORDOBA','CAT PORTO','CAT SAN SEBASTIAN','CEL','CINC','MIN','MIN-2','SAS','SHM','VVB','ICN-ABAL-1668','ICN-ABAL-1740','ICN-ABAL-1799','ICN-ABAL-1835','ICN-ABAL-1847','ICN-ABAL-2377','ICN-ABAL-2628','ICN-ABAL-2667','ICN-ABAL-2936'];
  const _isAll = String(aloj==null?'':aloj).indexOf('__ALL__') >= 0;
  const _alojList = _isAll ? ALL_ALOJ.slice() : String(aloj==null?'':aloj).split('|').map(function(x){return x.trim();}).filter(Boolean);
  const _alojSafe = _alojList.length ? _alojList : ['AB'];
  const alojIN = '{' + _alojSafe.map(function(a){return '"'+a.replace(/"/g,'')+'"';}).join(',') + '}';

  // Filtro de anio por RANGO de fechas (equivalente exacto a YEAR()=y, pero el storage engine lo resuelve mucho mas rapido).
  const _yEst = (y) => `'Informe Reservas Total'[Fecha Estancia]>=DATE(${y},1,1)&&'Informe Reservas Total'[Fecha Estancia]<DATE(${y+1},1,1)`;
  const _yChk = (y) => `'Informe Reservas Total'[CHECK IN]>=DATE(${y},1,1)&&'Informe Reservas Total'[CHECK IN]<DATE(${y+1},1,1)`;
  const F26 = `'Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Status]="CONFIRMED"&&${_yEst(year)}&&'Informe Reservas Total'[Conexion]="OK"`;
  const F25 = `'Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Status]="CONFIRMED"&&${_yEst(prevYear)}&&'Informe Reservas Total'[Conexion]="OK"`;
  const Fc26 = F26.replace('"CONFIRMED"', '"CANCELLED"');
  const Fc25 = F25.replace('"CONFIRMED"', '"CANCELLED"');

  const today = new Date();
  const todayDAX = `DATE(${today.getFullYear()},${today.getMonth()+1},${today.getDate()})`;
  const prevYearSameDay = `DATE(${today.getFullYear()-1},${today.getMonth()+1},${today.getDate()})`;
  const curMonth = today.getMonth() + 1;

  const _Q = {
    // KPIs YTD
    kpi: `EVALUATE ROW(
      "R26",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F26})),
      "N26",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F26})),
      "B26",CALCULATE(DISTINCTCOUNT('Informe Reservas Total'[Refer]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F26})),
      "Ni26",CALCULATE(SUM('Informe Reservas Total'[Nights]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F26})),
      "C26",CALCULATE(SUM('Informe Reservas Total'[room_commission_price])+SUM('Informe Reservas Total'[cf_commission_price]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F26})),
      "R25",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F25})),
      "N25",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F25})),
      "B25",CALCULATE(DISTINCTCOUNT('Informe Reservas Total'[Refer]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F25})),
      "Ni25",CALCULATE(SUM('Informe Reservas Total'[Nights]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F25})),
      "C25",CALCULATE(SUM('Informe Reservas Total'[room_commission_price])+SUM('Informe Reservas Total'[cf_commission_price]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F25}))
    )`,

    // Mes actual
ytdToday: `EVALUATE ROW("Rev",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F26}&&'Informe Reservas Total'[Fecha Estancia]<=${todayDAX})),"RN",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F26}&&'Informe Reservas Total'[Fecha Estancia]<=${todayDAX})),"BK",CALCULATE(DISTINCTCOUNT('Informe Reservas Total'[Refer]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F26}&&'Informe Reservas Total'[Fecha Estancia]<=${todayDAX})),"Ni",CALCULATE(SUM('Informe Reservas Total'[Nights]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F26}&&'Informe Reservas Total'[Fecha Estancia]<=${todayDAX})),"Rev25",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F25}&&'Informe Reservas Total'[Fecha Estancia]<=${prevYearSameDay})),"RN25",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F25}&&'Informe Reservas Total'[Fecha Estancia]<=${prevYearSameDay})),"BK25",CALCULATE(DISTINCTCOUNT('Informe Reservas Total'[Refer]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F25}&&'Informe Reservas Total'[Fecha Estancia]<=${prevYearSameDay})))`,

    losDist: `EVALUATE ROW("b1",CALCULATE(DISTINCTCOUNT('Informe Reservas Total'[Refer]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F26}&&DATEDIFF('Informe Reservas Total'[CHECK IN],'Informe Reservas Total'[CHECK OUT],DAY)=1)),"b2",CALCULATE(DISTINCTCOUNT('Informe Reservas Total'[Refer]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F26}&&DATEDIFF('Informe Reservas Total'[CHECK IN],'Informe Reservas Total'[CHECK OUT],DAY)=2)),"b3",CALCULATE(DISTINCTCOUNT('Informe Reservas Total'[Refer]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F26}&&DATEDIFF('Informe Reservas Total'[CHECK IN],'Informe Reservas Total'[CHECK OUT],DAY)=3)),"b47",CALCULATE(DISTINCTCOUNT('Informe Reservas Total'[Refer]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F26}&&DATEDIFF('Informe Reservas Total'[CHECK IN],'Informe Reservas Total'[CHECK OUT],DAY)>=4&&DATEDIFF('Informe Reservas Total'[CHECK IN],'Informe Reservas Total'[CHECK OUT],DAY)<=7)),"b8",CALCULATE(DISTINCTCOUNT('Informe Reservas Total'[Refer]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F26}&&DATEDIFF('Informe Reservas Total'[CHECK IN],'Informe Reservas Total'[CHECK OUT],DAY)>=8)))`,

    mesActual: `EVALUATE ROW(
      "Rev",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F26}&&MONTH('Informe Reservas Total'[Fecha Estancia])=${curMonth}&&'Informe Reservas Total'[Create time]<=${todayDAX})),
      "RN",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F26}&&MONTH('Informe Reservas Total'[Fecha Estancia])=${curMonth}&&'Informe Reservas Total'[Create time]<=${todayDAX})),
      "BK",CALCULATE(DISTINCTCOUNT('Informe Reservas Total'[Refer]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F26}&&MONTH('Informe Reservas Total'[Fecha Estancia])=${curMonth}&&'Informe Reservas Total'[Create time]<=${todayDAX})),
      "Rev25",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F25}&&MONTH('Informe Reservas Total'[Fecha Estancia])=${curMonth}&&'Informe Reservas Total'[Create time]<=${prevYearSameDay})),
      "RN25",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F25}&&MONTH('Informe Reservas Total'[Fecha Estancia])=${curMonth}&&'Informe Reservas Total'[Create time]<=${prevYearSameDay})),
      "BK25",CALCULATE(DISTINCTCOUNT('Informe Reservas Total'[Refer]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F25}&&MONTH('Informe Reservas Total'[Fecha Estancia])=${curMonth}&&'Informe Reservas Total'[Create time]<=${prevYearSameDay}))
    )`,

    // Deep Dive mes×propiedad 2026
    dp26: `EVALUATE SUMMARIZECOLUMNS(
      'Informe Reservas Total'[TipoHbitacion],
      'Informe Reservas Total'[Fecha Estancia],
      FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total',${F26}),
      "RN",COUNTROWS('Informe Reservas Total'),
      "BK",DISTINCTCOUNT('Informe Reservas Total'[Refer]),
      "Ni",SUM('Informe Reservas Total'[Nights]),
      "RevT",SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),
      "RevR",SUM('Informe Reservas Total'[ADR ING]),
      "Cm",SUM('Informe Reservas Total'[room_commission_price])+SUM('Informe Reservas Total'[cf_commission_price])
    ) ORDER BY 'Informe Reservas Total'[Fecha Estancia],'Informe Reservas Total'[TipoHbitacion]`,

    // Deep Dive mes×propiedad 2025
    dp25: `EVALUATE SUMMARIZECOLUMNS(
      'Informe Reservas Total'[TipoHbitacion],
      'Informe Reservas Total'[Fecha Estancia],
      FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total',${F25}),
      "RN",COUNTROWS('Informe Reservas Total'),
      "BK",DISTINCTCOUNT('Informe Reservas Total'[Refer]),
      "Ni",SUM('Informe Reservas Total'[Nights]),
      "RevT",SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),
      "RevR",SUM('Informe Reservas Total'[ADR ING]),
      "Cm",SUM('Informe Reservas Total'[room_commission_price])+SUM('Informe Reservas Total'[cf_commission_price])
    ) ORDER BY 'Informe Reservas Total'[Fecha Estancia],'Informe Reservas Total'[TipoHbitacion]`,

    // Cancelaciones mes×propiedad 2026
    canc26: `EVALUATE SUMMARIZECOLUMNS(
      'Informe Reservas Total'[TipoHbitacion],
      'Informe Reservas Total'[Fecha Estancia],
      FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total',${Fc26}),
      "CancBK",DISTINCTCOUNT('Informe Reservas Total'[Refer]),
      "CancRev",SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario])
    ) ORDER BY 'Informe Reservas Total'[Fecha Estancia],'Informe Reservas Total'[TipoHbitacion]`,

    // Cancelaciones mes×propiedad 2025
    canc25: `EVALUATE SUMMARIZECOLUMNS(
      'Informe Reservas Total'[TipoHbitacion],
      'Informe Reservas Total'[Fecha Estancia],
      FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total',${Fc25}),
      "CancBK",DISTINCTCOUNT('Informe Reservas Total'[Refer])
    ) ORDER BY 'Informe Reservas Total'[Fecha Estancia],'Informe Reservas Total'[TipoHbitacion]`,

    // Pace OTB — desde hoy en adelante
    pace26: `EVALUATE SUMMARIZECOLUMNS(
      'Informe Reservas Total'[Fecha Estancia],
      FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total',${F26}&&'Informe Reservas Total'[Fecha Estancia]>=${todayDAX}),
      "RN",COUNTROWS('Informe Reservas Total'),
      "RevT",SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario])
    ) ORDER BY 'Informe Reservas Total'[Fecha Estancia]`,

    // Pace LY — mismo punto año anterior
    pace25: `EVALUATE SUMMARIZECOLUMNS(
      'Informe Reservas Total'[Fecha Estancia],
      FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total',${F25}&&'Informe Reservas Total'[Fecha Estancia]>=${prevYearSameDay}),
      "RN",COUNTROWS('Informe Reservas Total')
    ) ORDER BY 'Informe Reservas Total'[Fecha Estancia]`,

    forecastPk: `EVALUATE CALCULATETABLE(ADDCOLUMNS(CROSSJOIN(SUMMARIZE(FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),Habitaciones[Property],Habitaciones[Tipo Habitación]),SUMMARIZE(FILTER('Fechas estancia','Fechas estancia'[Date]>=${todayDAX}&&'Fechas estancia'[Date]<=${todayDAX}+550),'Fechas estancia'[Year],'Fechas estancia'[Month])),"OTBR",[NOC AY BW +360],"OTBV",[ING AY BW +360],"P7R",[NOC LY BW +07],"P15R",[NOC LY BW +15],"P30R",[NOC LY BW +30],"P45R",[NOC LY BW +45],"P7V",[ING LY BW +07],"P15V",[ING LY BW +15],"P30V",[ING LY BW +30],"P45V",[ING LY BW +45]),Habitaciones[Alojamiento] IN ${alojIN},'Fecha Venta'[Date]=${todayDAX})`,

    // Clima (Meteo VCR) por fecha para la provincia del cliente — actual y rango LY
    // OTB por día y unidad (confirmado+OK) — para forecast multi-año + desglose por día
    fcOtbD: `EVALUATE SUMMARIZECOLUMNS('Informe Reservas Total'[Fecha Estancia],Habitaciones[Property],Habitaciones[Tipo Habitación],FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Status]="CONFIRMED"&&'Informe Reservas Total'[Conexion]="OK"&&'Informe Reservas Total'[Fecha Estancia]>=${todayDAX}&&'Informe Reservas Total'[Fecha Estancia]<=${todayDAX}+420),"RN",COUNTROWS('Informe Reservas Total'),"Rev",SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]))`,
    meteoFc: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('Meteo VCR'[date],"T",AVERAGE('Meteo VCR'[temp]),"W",MAXX(VALUES('Meteo VCR'[weather]),'Meteo VCR'[weather])),Habitaciones[Alojamiento] IN ${alojIN},'Meteo VCR'[date]>=${todayDAX}-380&&'Meteo VCR'[date]<=${todayDAX}+560)`,

    // Pick Up últimas 2 semanas
    pickup: `EVALUATE SUMMARIZECOLUMNS(
      'Informe Reservas Total'[Create time],
      FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total',
        'Informe Reservas Total'[Alojamiento] IN ${alojIN}&&
        'Informe Reservas Total'[Conexion]="OK"&&
        'Informe Reservas Total'[Create time]>=${todayDAX}-14&&
        'Informe Reservas Total'[Create time]<=${todayDAX}
      ),
      "Conf",CALCULATE(DISTINCTCOUNT('Informe Reservas Total'[Refer]),'Informe Reservas Total'[Status]="CONFIRMED"),
      "Canc",CALCULATE(DISTINCTCOUNT('Informe Reservas Total'[Refer]),'Informe Reservas Total'[Status]="CANCELLED"),
      "Rev",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),'Informe Reservas Total'[Status]="CONFIRMED")
    ) ORDER BY 'Informe Reservas Total'[Create time]`,

    // Cancelaciones por canal
    pickupDaily: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('Fecha Venta'[Date],'Fechas estancia'[Year],
      FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&'Informe Reservas Total'[Create time]>=${todayDAX}-31),
      "BK",CALCULATE(DISTINCTCOUNT('Informe Reservas Total'[Refer]),'Informe Reservas Total'[Status]="CONFIRMED"),
      "RN",CALCULATE(COUNTROWS('Informe Reservas Total'),'Informe Reservas Total'[Status]="CONFIRMED"),
      "Rev",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),'Informe Reservas Total'[Status]="CONFIRMED"),
      "CBK",CALCULATE(DISTINCTCOUNT('Informe Reservas Total'[Refer]),'Informe Reservas Total'[Status]="CANCELLED"),
      "CRN",CALCULATE(COUNTROWS('Informe Reservas Total'),'Informe Reservas Total'[Status]="CANCELLED"),
      "CRev",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),'Informe Reservas Total'[Status]="CANCELLED"))) ORDER BY 'Fecha Venta'[Date] DESC`,

    pickupMonth: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('Fecha Venta'[Date],'Fechas estancia'[Year],'Fechas estancia'[Month],Habitaciones[Property],Habitaciones[Tipo Habitación],Habitaciones[Location],'Informe Reservas Total'[Source Filtro],'Informe Reservas Total'[Rate plan],'Informe Reservas Total'[Country],
      FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&'Informe Reservas Total'[Create time]>=${todayDAX}-31),
      "BK",CALCULATE(DISTINCTCOUNT('Informe Reservas Total'[Refer]),'Informe Reservas Total'[Status]="CONFIRMED"),
      "RN",CALCULATE(COUNTROWS('Informe Reservas Total'),'Informe Reservas Total'[Status]="CONFIRMED"),
      "Rev",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),'Informe Reservas Total'[Status]="CONFIRMED"),
      "CRN",CALCULATE(COUNTROWS('Informe Reservas Total'),'Informe Reservas Total'[Status]="CANCELLED")))`,

    pickupLY: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('Fecha Venta'[Date],'Fechas estancia'[Year],'Fechas estancia'[Month],Habitaciones[Property],Habitaciones[Tipo Habitación],Habitaciones[Location],'Informe Reservas Total'[Source Filtro],'Informe Reservas Total'[Rate plan],'Informe Reservas Total'[Country],
      FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&'Informe Reservas Total'[Create time]>=${todayDAX}-396&&'Informe Reservas Total'[Create time]<${todayDAX}-364),
      "BK",CALCULATE(DISTINCTCOUNT('Informe Reservas Total'[Refer]),'Informe Reservas Total'[Status]="CONFIRMED"),
      "RN",CALCULATE(COUNTROWS('Informe Reservas Total'),'Informe Reservas Total'[Status]="CONFIRMED"),
      "Rev",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),'Informe Reservas Total'[Status]="CONFIRMED")))`,

    pickupStay: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('Fecha Venta'[Date],'Fechas estancia'[Date],
      FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&'Informe Reservas Total'[Status]="CONFIRMED"&&'Informe Reservas Total'[Create time]>=${todayDAX}-31),
      "RN",COUNTROWS('Informe Reservas Total'),
      "Rev",SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario])))`,

    pickupStayLY: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('Fecha Venta'[Date],'Fechas estancia'[Date],
      FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&'Informe Reservas Total'[Status]="CONFIRMED"&&'Informe Reservas Total'[Create time]>=${todayDAX}-396&&'Informe Reservas Total'[Create time]<${todayDAX}-364),
      "RN",COUNTROWS('Informe Reservas Total'),
      "Rev",SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario])))`,

    paceM: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('Fechas estancia'[Year],'Fechas estancia'[Month],"RN",COUNTROWS('Informe Reservas Total'),"ING",SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario])),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&'Informe Reservas Total'[Status]="CONFIRMED"&&'Informe Reservas Total'[Create time]<=${todayDAX}),FILTER('Fechas estancia','Fechas estancia'[Date]>=${todayDAX})) ORDER BY 'Fechas estancia'[Year],'Fechas estancia'[Month]`,

    paceMLY: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('Fechas estancia'[Year],'Fechas estancia'[Month],"RN",COUNTROWS('Informe Reservas Total'),"ING",SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario])),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&'Informe Reservas Total'[Status]="CONFIRMED"&&'Informe Reservas Total'[Create time]<=${todayDAX}-365),FILTER('Fechas estancia','Fechas estancia'[Date]>=${todayDAX}-365&&'Fechas estancia'[Date]<${todayDAX}-365+400)) ORDER BY 'Fechas estancia'[Year],'Fechas estancia'[Month]`,

    paceD: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('Fechas estancia'[Date],"RN",COUNTROWS('Informe Reservas Total'),"ING",SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario])),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&'Informe Reservas Total'[Status]="CONFIRMED"&&'Informe Reservas Total'[Create time]<=${todayDAX}),FILTER('Fechas estancia','Fechas estancia'[Date]>=${todayDAX}))`,

    paceDLY: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('Fechas estancia'[Date],"RN",COUNTROWS('Informe Reservas Total'),"ING",SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario])),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&'Informe Reservas Total'[Status]="CONFIRMED"&&'Informe Reservas Total'[Create time]<=${todayDAX}-365),FILTER('Fechas estancia','Fechas estancia'[Date]>=${todayDAX}-365&&'Fechas estancia'[Date]<${todayDAX}-365+400))`,

    paceDim: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('Fechas estancia'[Year],'Fechas estancia'[Month],Habitaciones[Property],Habitaciones[Tipo Habitación],Habitaciones[Location],'Informe Reservas Total'[Source Filtro],'Informe Reservas Total'[Rate plan],'Informe Reservas Total'[Country],"RN",COUNTROWS('Informe Reservas Total'),"ING",SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario])),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&'Informe Reservas Total'[Status]="CONFIRMED"&&'Informe Reservas Total'[Create time]<=${todayDAX}),FILTER('Fechas estancia','Fechas estancia'[Date]>=${todayDAX}))`,

    paceDimLY: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('Fechas estancia'[Year],'Fechas estancia'[Month],Habitaciones[Property],Habitaciones[Tipo Habitación],Habitaciones[Location],'Informe Reservas Total'[Source Filtro],'Informe Reservas Total'[Rate plan],'Informe Reservas Total'[Country],"RN",COUNTROWS('Informe Reservas Total'),"ING",SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario])),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&'Informe Reservas Total'[Status]="CONFIRMED"&&'Informe Reservas Total'[Create time]<=${todayDAX}-365),FILTER('Fechas estancia','Fechas estancia'[Date]>=${todayDAX}-365&&'Fechas estancia'[Date]<${todayDAX}-365+400))`,

    dpUnit26: `EVALUATE SUMMARIZECOLUMNS(Habitaciones[Property],Habitaciones[Tipo Habitación],FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total',${F26}),"RN",COUNTROWS('Informe Reservas Total'),"BK",DISTINCTCOUNT('Informe Reservas Total'[Refer]),"RevT",SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]))`,

    dpUnit25: `EVALUATE SUMMARIZECOLUMNS(Habitaciones[Property],Habitaciones[Tipo Habitación],FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total',${F25}),"RN",COUNTROWS('Informe Reservas Total'),"BK",DISTINCTCOUNT('Informe Reservas Total'[Refer]),"RevT",SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]))`,

    dpChan26: `EVALUATE SUMMARIZECOLUMNS('Informe Reservas Total'[Source Filtro],FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total',${F26}),"BK",DISTINCTCOUNT('Informe Reservas Total'[Refer]),"RN",COUNTROWS('Informe Reservas Total'),"RevT",SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),"Cm",SUM('Informe Reservas Total'[room_commission_price])+SUM('Informe Reservas Total'[cf_commission_price]))`,

    dpChan25: `EVALUATE SUMMARIZECOLUMNS('Informe Reservas Total'[Source Filtro],FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total',${F25}),"BK",DISTINCTCOUNT('Informe Reservas Total'[Refer]),"RN",COUNTROWS('Informe Reservas Total'),"RevT",SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]))`,

    bwProp26: `EVALUATE SUMMARIZECOLUMNS(Habitaciones[Property],FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total',${F26}),"n0",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=1)),"r0",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=1)),"n1",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=2&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=7)),"r1",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=2&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=7)),"n2",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=8&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=14)),"r2",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=8&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=14)),"n3",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=15&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=30)),"r3",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=15&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=30)),"n4",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=31&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=60)),"r4",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=31&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=60)),"n5",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=61&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=90)),"r5",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=61&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=90)),"n6",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>90)),"r6",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>90)))`,

    bwChan26: `EVALUATE SUMMARIZECOLUMNS('Informe Reservas Total'[Source Filtro],FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total',${F26}),"n0",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=1)),"r0",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=1)),"n1",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=2&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=7)),"r1",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=2&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=7)),"n2",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=8&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=14)),"r2",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=8&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=14)),"n3",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=15&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=30)),"r3",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=15&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=30)),"n4",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=31&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=60)),"r4",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=31&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=60)),"n5",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=61&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=90)),"r5",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=61&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=90)),"n6",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>90)),"r6",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>90)))`,

    qualSrc: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('Calidad Reyvoos * Carga'[Reviews.a_reviews.type_source_reviews],"Nota",AVERAGE('Calidad Reyvoos * Carga'[Nota]),"Reviews",COUNTROWS('Calidad Reyvoos * Carga')),FILTER(Habitaciones,Habitaciones[Alojamiento] IN ${alojIN}),FILTER('Calidad Reyvoos * Carga',YEAR('Calidad Reyvoos * Carga'[Fecha])=${year}))`,

    qualUnit: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS(Habitaciones[Property],Habitaciones[Tipo Habitación],"Nota",AVERAGE('Calidad Reyvoos * Carga'[Nota]),"Reviews",COUNTROWS('Calidad Reyvoos * Carga')),FILTER(Habitaciones,Habitaciones[Alojamiento] IN ${alojIN}),FILTER('Calidad Reyvoos * Carga',YEAR('Calidad Reyvoos * Carga'[Fecha])=${year}))`,

    qualMonth: `EVALUATE CALCULATETABLE(GROUPBY(ADDCOLUMNS('Calidad Reyvoos * Carga',"YM",YEAR('Calidad Reyvoos * Carga'[Fecha])*100+MONTH('Calidad Reyvoos * Carga'[Fecha])),[YM],"nota",AVERAGEX(CURRENTGROUP(),'Calidad Reyvoos * Carga'[Nota]),"n",COUNTX(CURRENTGROUP(),'Calidad Reyvoos * Carga'[Nota])),FILTER(Habitaciones,Habitaciones[Alojamiento] IN ${alojIN}))`,

    qualRev: `EVALUATE TOPN(1500, CALCULATETABLE(SELECTCOLUMNS('Calidad Reyvoos * Carga', "f",'Calidad Reyvoos * Carga'[Fecha], "sc",'Calidad Reyvoos * Carga'[Reviews.a_reviews.score_reviews], "src",'Calidad Reyvoos * Carga'[Reviews.a_reviews.type_source_reviews], "unit",'Calidad Reyvoos * Carga'[UnitType], "hold",'Calidad Reyvoos * Carga'[Listed Holdings.a_holdings.name_holding], "txt",'Calidad Reyvoos * Carga'[Review]), FILTER(Habitaciones,Habitaciones[Alojamiento] IN ${alojIN}),FILTER('Calidad Reyvoos * Carga',YEAR('Calidad Reyvoos * Carga'[Fecha])=${year})), [f], DESC)`,

    bookerCty: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('Informe Reservas Total'[Country],"bk",DISTINCTCOUNT('Informe Reservas Total'[Refer]),"rn",COUNTROWS('Informe Reservas Total'),"rev",SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),"bwsum",SUMX('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time])))),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER(ALL('Informe Reservas Total'),${F26}))`,

    salesDay: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('Fechas estancia'[Date],Habitaciones[Property],Habitaciones[Tipo Habitación],"RN",COUNTROWS('Informe Reservas Total'),"BK",DISTINCTCOUNT('Informe Reservas Total'[Refer]),"Ni",SUM('Informe Reservas Total'[Nights]),"Pax",SUM('Informe Reservas Total'[GUESTS]),"RevR",SUM('Informe Reservas Total'[ADR ING]),"Clean",SUM('Informe Reservas Total'[Cleaning Diario]),"Extra",SUM('Informe Reservas Total'[Extras Diario]),"ComR",SUM('Informe Reservas Total'[room_commission_price]),"ComC",SUM('Informe Reservas Total'[cf_commission_price]),"BWsum",SUMX('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time])))),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total',${F26}))`,


    salesDim: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('Fechas estancia'[Year],'Fechas estancia'[Month],Habitaciones[Property],Habitaciones[Tipo Habitación],Habitaciones[Location],'Informe Reservas Total'[Source Filtro],'Informe Reservas Total'[Rate plan],'Informe Reservas Total'[Country],"RN",COUNTROWS('Informe Reservas Total'),"BK",DISTINCTCOUNT('Informe Reservas Total'[Refer]),"Ni",SUM('Informe Reservas Total'[Nights]),"Pax",SUM('Informe Reservas Total'[GUESTS]),"RevR",SUM('Informe Reservas Total'[ADR ING]),"Clean",SUM('Informe Reservas Total'[Cleaning Diario]),"Extra",SUM('Informe Reservas Total'[Extras Diario]),"ComR",SUM('Informe Reservas Total'[room_commission_price]),"ComC",SUM('Informe Reservas Total'[cf_commission_price]),"BWsum",SUMX('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time])))),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total',${F26}))`,


    salesDimLY: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('Fechas estancia'[Year],'Fechas estancia'[Month],Habitaciones[Property],Habitaciones[Tipo Habitación],Habitaciones[Location],'Informe Reservas Total'[Source Filtro],'Informe Reservas Total'[Rate plan],'Informe Reservas Total'[Country],"RN",COUNTROWS('Informe Reservas Total'),"BK",DISTINCTCOUNT('Informe Reservas Total'[Refer]),"Ni",SUM('Informe Reservas Total'[Nights]),"Pax",SUM('Informe Reservas Total'[GUESTS]),"RevR",SUM('Informe Reservas Total'[ADR ING]),"Clean",SUM('Informe Reservas Total'[Cleaning Diario]),"Extra",SUM('Informe Reservas Total'[Extras Diario]),"ComR",SUM('Informe Reservas Total'[room_commission_price]),"ComC",SUM('Informe Reservas Total'[cf_commission_price]),"BWsum",SUMX('Informe Reservas Total',(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time])))),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total',${F25}))`,


    salesCanc: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('Fechas estancia'[Year],'Fechas estancia'[Month],Habitaciones[Property],Habitaciones[Tipo Habitación],Habitaciones[Location],'Informe Reservas Total'[Source Filtro],'Informe Reservas Total'[Rate plan],'Informe Reservas Total'[Country],"cRN",COUNTROWS('Informe Reservas Total'),"cBK",DISTINCTCOUNT('Informe Reservas Total'[Refer]),"cRev",SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),"cCom",SUM('Informe Reservas Total'[room_commission_price])+SUM('Informe Reservas Total'[cf_commission_price])),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Status]="CANCELLED"&&${_yEst(year)}))`,


    salesCancLY: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('Fechas estancia'[Year],'Fechas estancia'[Month],Habitaciones[Property],Habitaciones[Tipo Habitación],Habitaciones[Location],'Informe Reservas Total'[Source Filtro],'Informe Reservas Total'[Rate plan],'Informe Reservas Total'[Country],"cRN",COUNTROWS('Informe Reservas Total'),"cBK",DISTINCTCOUNT('Informe Reservas Total'[Refer]),"cRev",SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),"cCom",SUM('Informe Reservas Total'[room_commission_price])+SUM('Informe Reservas Total'[cf_commission_price])),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Status]="CANCELLED"&&${_yEst(prevYear)}))`,


    capDim: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('Habitaciones Diarias'[Property],'Habitaciones Diarias'[Tipo Habitación],'Fechas estancia'[Year],'Fechas estancia'[Month],"cap",SUM('Habitaciones Diarias'[Total Room]),"blk",SUM('Habitaciones Diarias'[Bloqueo])),FILTER('Habitaciones Diarias','Habitaciones Diarias'[Alojamiento] IN ${alojIN}),FILTER('Fechas estancia','Fechas estancia'[Year]>=2025))`,


    unitsCount: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS(Habitaciones[Property],Habitaciones[Tipo Habitación],"u",DISTINCTCOUNT(Habitaciones[Nº Habitación])),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"&&Habitaciones[Alojamiento] IN ${alojIN}))`,


    market26: `EVALUATE ADDCOLUMNS(GENERATESERIES(1,12,1),"p25",CALCULATE(AVERAGE('Informe MarketData PL'[25th Percentile]),FILTER(Habitaciones,Habitaciones[Alojamiento] IN ${alojIN}),FILTER('Informe MarketData PL',MONTH('Informe MarketData PL'[date])=[Value]&&YEAR('Informe MarketData PL'[date])=${year})),"p50",CALCULATE(AVERAGE('Informe MarketData PL'[50th Percentile]),FILTER(Habitaciones,Habitaciones[Alojamiento] IN ${alojIN}),FILTER('Informe MarketData PL',MONTH('Informe MarketData PL'[date])=[Value]&&YEAR('Informe MarketData PL'[date])=${year})),"p75",CALCULATE(AVERAGE('Informe MarketData PL'[75th Percentile]),FILTER(Habitaciones,Habitaciones[Alojamiento] IN ${alojIN}),FILTER('Informe MarketData PL',MONTH('Informe MarketData PL'[date])=[Value]&&YEAR('Informe MarketData PL'[date])=${year})),"occ",CALCULATE(AVERAGE('Informe MarketData PL'[Occupancy]),FILTER(Habitaciones,Habitaciones[Alojamiento] IN ${alojIN}),FILTER('Informe MarketData PL',MONTH('Informe MarketData PL'[date])=[Value]&&YEAR('Informe MarketData PL'[date])=${year})))`,

    waKPI: `EVALUATE ROW("users",CALCULATE(DISTINCTCOUNT('Data_GA4***'[user_pseudo_id]),'Data_GA4***'[Alojamiento] IN ${alojIN}),"pviews",CALCULATE(COUNTROWS('Data_GA4***'),'Data_GA4***'[Alojamiento] IN ${alojIN}&&'Data_GA4***'[event_name]="page_view"),"clicks",CALCULATE(SUM('Data_GSC***'[clicks]),'Data_GSC***'[Source.Name] IN ${alojIN}),"impr",CALCULATE(SUM('Data_GSC***'[impressions]),'Data_GSC***'[Source.Name] IN ${alojIN}),"pos",CALCULATE(AVERAGE('Data_GSC***'[position]),'Data_GSC***'[Source.Name] IN ${alojIN}),"reservas",CALCULATE(COUNTROWS('Data_GA4***'),'Data_GA4***'[Alojamiento] IN ${alojIN}&&'Data_GA4***'[event_name]="reserva_fin"))`,

    waSrc: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('Data_GA4***'[traffic_source.source],"u",DISTINCTCOUNT('Data_GA4***'[user_pseudo_id])),'Data_GA4***'[Alojamiento] IN ${alojIN})`,

    waDev: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('Data_GA4***'[device.category],"u",DISTINCTCOUNT('Data_GA4***'[user_pseudo_id])),'Data_GA4***'[Alojamiento] IN ${alojIN})`,

    waGrowth: `EVALUATE CALCULATETABLE(GROUPBY(ADDCOLUMNS('Data_GA4***',"YM",INT('Data_GA4***'[event_date]/100)),[YM],"v",COUNTX(CURRENTGROUP(),'Data_GA4***'[user_pseudo_id])),'Data_GA4***'[Alojamiento] IN ${alojIN}&&'Data_GA4***'[event_name]="session_start")`,
    waDur: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('Data_GA4***'[Group duration],"n",COUNTROWS('Data_GA4***')),'Data_GA4***'[Alojamiento] IN ${alojIN}&&'Data_GA4***'[event_name]="busq_dispo")`,
    waPax: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('Data_GA4***'[Group pax],"n",COUNTROWS('Data_GA4***')),'Data_GA4***'[Alojamiento] IN ${alojIN}&&'Data_GA4***'[event_name]="busq_dispo")`,
    waDates: `EVALUATE CALCULATETABLE(GROUPBY(ADDCOLUMNS('Data_GA4***',"YM",YEAR('Data_GA4***'[fecha_inicio])*100+MONTH('Data_GA4***'[fecha_inicio])),[YM],"n",COUNTX(CURRENTGROUP(),'Data_GA4***'[user_pseudo_id])),'Data_GA4***'[Alojamiento] IN ${alojIN}&&'Data_GA4***'[event_name]="busq_dispo")`,
    waQry: `EVALUATE TOPN(15, CALCULATETABLE(SUMMARIZECOLUMNS('Data_GSC***'[query],"c",SUM('Data_GSC***'[clicks]),"i",SUM('Data_GSC***'[impressions])),'Data_GSC***'[Source.Name] IN ${alojIN}), [c], DESC)`,

    plCosts: `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('P&G'[Partida],'P&G'[Tipo Costes.Tipo Coste],"Coste",SUM('P&G'[Costes Operativos])),FILTER('P&G','P&G'[Alojamiento] IN ${alojIN}&&YEAR('P&G'[Fecha])=${year})) ORDER BY [Coste] DESC`,

    bwLead: `EVALUATE GROUPBY(GROUPBY(ADDCOLUMNS(FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&${_yChk(year)}),"B",VAR d=DATEDIFF('Informe Reservas Total'[Create time],'Informe Reservas Total'[CHECK IN],DAY) RETURN SWITCH(TRUE(),d<=1,0,d<=7,1,d<=14,2,d<=30,3,d<=60,4,d<=90,5,6)),'Informe Reservas Total'[Refer],[B],'Informe Reservas Total'[Status],"rn",SUMX(CURRENTGROUP(),1),"rev",SUMX(CURRENTGROUP(),('Informe Reservas Total'[ADR ING]+'Informe Reservas Total'[Cleaning Diario]+'Informe Reservas Total'[Extras Diario]))),[B],'Informe Reservas Total'[Status],"bk",SUMX(CURRENTGROUP(),1),"rn",SUMX(CURRENTGROUP(),[rn]),"rev",SUMX(CURRENTGROUP(),[rev]))`,
    bwLeadLY: `EVALUATE GROUPBY(GROUPBY(ADDCOLUMNS(FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&${_yChk(prevYear)}),"B",VAR d=DATEDIFF('Informe Reservas Total'[Create time],'Informe Reservas Total'[CHECK IN],DAY) RETURN SWITCH(TRUE(),d<=1,0,d<=7,1,d<=14,2,d<=30,3,d<=60,4,d<=90,5,6)),'Informe Reservas Total'[Refer],[B],'Informe Reservas Total'[Status],"rn",SUMX(CURRENTGROUP(),1),"rev",SUMX(CURRENTGROUP(),('Informe Reservas Total'[ADR ING]+'Informe Reservas Total'[Cleaning Diario]+'Informe Reservas Total'[Extras Diario]))),[B],'Informe Reservas Total'[Status],"bk",SUMX(CURRENTGROUP(),1),"rn",SUMX(CURRENTGROUP(),[rn]),"rev",SUMX(CURRENTGROUP(),[rev]))`,
    bwMon: `EVALUATE GROUPBY(GROUPBY(ADDCOLUMNS(FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&('Informe Reservas Total'[CHECK IN]>=DATE(${prevYear},1,1)&&'Informe Reservas Total'[CHECK IN]<DATE(${year}+1,1,1))),"M",MONTH('Informe Reservas Total'[CHECK IN]),"Y",YEAR('Informe Reservas Total'[CHECK IN])),'Informe Reservas Total'[Refer],[M],[Y],'Informe Reservas Total'[Status]),[Y],[M],'Informe Reservas Total'[Status],"bk",SUMX(CURRENTGROUP(),1))`,
    paceLead: `EVALUATE ROW("n0",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&'Informe Reservas Total'[Status]="CONFIRMED"&&'Informe Reservas Total'[Create time]<=${todayDAX}&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=1),FILTER('Fechas estancia','Fechas estancia'[Date]>=${todayDAX})),"r0",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&'Informe Reservas Total'[Status]="CONFIRMED"&&'Informe Reservas Total'[Create time]<=${todayDAX}&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=1),FILTER('Fechas estancia','Fechas estancia'[Date]>=${todayDAX})),"n1",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&'Informe Reservas Total'[Status]="CONFIRMED"&&'Informe Reservas Total'[Create time]<=${todayDAX}&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=2&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=7),FILTER('Fechas estancia','Fechas estancia'[Date]>=${todayDAX})),"r1",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&'Informe Reservas Total'[Status]="CONFIRMED"&&'Informe Reservas Total'[Create time]<=${todayDAX}&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=2&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=7),FILTER('Fechas estancia','Fechas estancia'[Date]>=${todayDAX})),"n2",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&'Informe Reservas Total'[Status]="CONFIRMED"&&'Informe Reservas Total'[Create time]<=${todayDAX}&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=8&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=14),FILTER('Fechas estancia','Fechas estancia'[Date]>=${todayDAX})),"r2",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&'Informe Reservas Total'[Status]="CONFIRMED"&&'Informe Reservas Total'[Create time]<=${todayDAX}&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=8&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=14),FILTER('Fechas estancia','Fechas estancia'[Date]>=${todayDAX})),"n3",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&'Informe Reservas Total'[Status]="CONFIRMED"&&'Informe Reservas Total'[Create time]<=${todayDAX}&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=15&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=30),FILTER('Fechas estancia','Fechas estancia'[Date]>=${todayDAX})),"r3",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&'Informe Reservas Total'[Status]="CONFIRMED"&&'Informe Reservas Total'[Create time]<=${todayDAX}&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=15&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=30),FILTER('Fechas estancia','Fechas estancia'[Date]>=${todayDAX})),"n4",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&'Informe Reservas Total'[Status]="CONFIRMED"&&'Informe Reservas Total'[Create time]<=${todayDAX}&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=31&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=60),FILTER('Fechas estancia','Fechas estancia'[Date]>=${todayDAX})),"r4",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&'Informe Reservas Total'[Status]="CONFIRMED"&&'Informe Reservas Total'[Create time]<=${todayDAX}&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=31&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=60),FILTER('Fechas estancia','Fechas estancia'[Date]>=${todayDAX})),"n5",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&'Informe Reservas Total'[Status]="CONFIRMED"&&'Informe Reservas Total'[Create time]<=${todayDAX}&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=61&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=90),FILTER('Fechas estancia','Fechas estancia'[Date]>=${todayDAX})),"r5",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&'Informe Reservas Total'[Status]="CONFIRMED"&&'Informe Reservas Total'[Create time]<=${todayDAX}&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>=61&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))<=90),FILTER('Fechas estancia','Fechas estancia'[Date]>=${todayDAX})),"n6",CALCULATE(COUNTROWS('Informe Reservas Total'),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&'Informe Reservas Total'[Status]="CONFIRMED"&&'Informe Reservas Total'[Create time]<=${todayDAX}&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>90),FILTER('Fechas estancia','Fechas estancia'[Date]>=${todayDAX})),"r6",CALCULATE(SUM('Informe Reservas Total'[ADR ING])+SUM('Informe Reservas Total'[Cleaning Diario])+SUM('Informe Reservas Total'[Extras Diario]),FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total','Informe Reservas Total'[Alojamiento] IN ${alojIN}&&'Informe Reservas Total'[Conexion]="OK"&&'Informe Reservas Total'[Status]="CONFIRMED"&&'Informe Reservas Total'[Create time]<=${todayDAX}&&(INT('Informe Reservas Total'[Fecha Estancia])-INT('Informe Reservas Total'[Create time]))>90),FILTER('Fechas estancia','Fechas estancia'[Date]>=${todayDAX})))`,

    eventos: `EVALUATE VAR _locs=CALCULATETABLE(VALUES(Habitaciones[Location]),Habitaciones[Alojamiento] IN ${alojIN}) RETURN CALCULATETABLE(SUMMARIZECOLUMNS('Eventos'[Día],'Eventos'[País/Ciudad],'Eventos'[Evento Resumen],'Eventos'[Festivo]),FILTER('Eventos','Eventos'[Día]>=${todayDAX}&&'Eventos'[Día]<=${todayDAX}+180&&'Eventos'[País/Ciudad] IN _locs)) ORDER BY 'Eventos'[Día] ASC`,

    geo: `EVALUATE SUMMARIZECOLUMNS(Habitaciones[Location],Habitaciones[Country ISO],Habitaciones[Region],FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"&&Habitaciones[Alojamiento] IN ${alojIN}))`,
    cancCh: `EVALUATE SUMMARIZECOLUMNS(
      'Informe Reservas Total'[Source Filtro],
      FILTER(Habitaciones,Habitaciones[Activo_Condicional]="Activo"),FILTER('Informe Reservas Total',
        'Informe Reservas Total'[Alojamiento] IN ${alojIN}&&
        'Informe Reservas Total'[Status]="CANCELLED"&&
        ${_yEst(year)}&&
        'Informe Reservas Total'[Conexion]="OK"
      ),
      "Cancel",DISTINCTCOUNT('Informe Reservas Total'[Refer])
    ) ORDER BY [Cancel] DESC`
  };
  // (modo ligero retirado: cada cliente carga TODAS sus consultas)
  return _Q;
}

// ── Procesar raw data ─────────────────────────────────────────────────
function processData(raw, year) {
  const UNID = { Barrio: 4, Mercado: 2, Teatro: 2 };
  const DIAS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const MSH  = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

  const DK = 'Informe Reservas Total[Fecha Estancia]';
  const PK = 'Informe Reservas Total[TipoHbitacion]';
  const CK = 'Informe Reservas Total[Source Filtro]';

  // Deep Dive mes×propiedad
  function aggDP(rows, cancRows) {
    const cMap = {};
    (cancRows || []).forEach(r => {
      const m = new Date(r[DK]).getMonth();
      const p = r[PK] || '?';
      const k = `${m}|${p}`;
      if (!cMap[k]) cMap[k] = { cBK: 0, cRev: 0 };
      cMap[k].cBK  += r['[CancBK]']  || 0;
      cMap[k].cRev += r['[CancRev]'] || 0;
    });

    const map = {};
    rows.forEach(r => {
      const m = new Date(r[DK]).getMonth();
      const p = r[PK] || '?';
      const k = `${m}|${p}`;
      if (!map[k]) map[k] = { m, p, rn:0, bk:0, ni:0, revT:0, revR:0, cm:0 };
      map[k].rn   += r['[RN]']   || 0;
      map[k].bk   += r['[BK]']   || 0;
      map[k].ni   += r['[Ni]']   || 0;
      map[k].revT += r['[RevT]'] || 0;
      map[k].revR += r['[RevR]'] || 0;
      map[k].cm   += r['[Cm]']   || 0;
    });

    return Object.values(map).map(x => {
      const u    = UNID[x.p] || 1;
      const disp = DIAS[x.m] * u;
      const cc   = cMap[`${x.m}|${x.p}`] || { cBK: 0, cRev: 0 };
      const nRT  = x.revT - x.cm;
      const nRR  = x.revR - x.cm;
      return {
        m: x.m, p: x.p, u,
        rn: x.rn, bk: x.bk, ni: Math.round(x.ni),
        disp,
        occ:    +(x.rn / disp * 100).toFixed(2),
        nocc:   +(x.rn * 0.95 / disp * 100).toFixed(2),
        oor:    Math.round(x.rn * 0.03) || 0,
        adrT:   x.rn > 0 ? +(x.revT / x.rn).toFixed(1) : 0,
        adrR:   x.rn > 0 ? +(x.revR / x.rn).toFixed(1) : 0,
        nadrT:  x.rn > 0 ? +(nRT / x.rn).toFixed(1) : 0,
        nadrR:  x.rn > 0 ? +(nRR / x.rn).toFixed(1) : 0,
        revT:   Math.round(x.revT),
        revR:   Math.round(x.revR),
        nRevT:  Math.round(nRT),
        nRevR:  Math.round(nRR),
        revPAR:  +(x.revT / disp).toFixed(1),
        nRevPAR: +(nRT    / disp).toFixed(1),
        cm:     Math.round(x.cm),
        cmPct:  x.revT > 0 ? +(x.cm / x.revT * 100).toFixed(2) : 0,
        los:    x.rn > 0 ? +(x.ni / x.rn).toFixed(1) : 0,
        cancBK:   cc.cBK,
        cancRev:  Math.round(cc.cRev),
        cancRate: x.bk > 0 ? +(cc.cBK / (x.bk + cc.cBK) * 100).toFixed(2) : 0
      };
    }).sort((a, b) => a.m - b.m || a.p.localeCompare(b.p));
  }

  // Pace por mes
  function aggPace(rows) {
    const o = Array(12).fill(null).map(() => ({ rn: 0, rev: 0 }));
    rows.forEach(r => {
      const m = new Date(r[DK]).getMonth();
      o[m].rn  += r['[RN]']   || 0;
      o[m].rev += r['[RevT]'] || 0;
    });
    return o.map((x, i) => ({ mi: i, mes: MSH[i], rn: x.rn, rev: Math.round(x.rev) }))
            .filter(x => x.rn > 0);
  }

  // KPI totales
  const k  = raw.kpi[0] || {};
  const R26 = Math.round(k['[R26]'] || 0), N26 = k['[N26]'] || 0, B26 = k['[B26]'] || 0;
  const Ni26 = Math.round(k['[Ni26]'] || 0), C26 = Math.round(k['[C26]'] || 0);
  const R25 = Math.round(k['[R25]'] || 0), N25 = k['[N25]'] || 0, B25 = k['[B25]'] || 0;
  const Ni25 = Math.round(k['[Ni25]'] || 0), C25 = Math.round(k['[C25]'] || 0);

  // Mes actual
  const ma = raw.mesActual[0] || {};
  const maRev = Math.round(ma['[Rev]']  || 0), maRN  = ma['[RN]']  || 0, maBK = ma['[BK]'] || 0;
  const maR25 = Math.round(ma['[Rev25]'] || 0), maN25 = ma['[RN25]'] || 0;

  // Deep Dive
  const dp26 = aggDP(raw.dp26, raw.canc26);
  const dp25 = aggDP(raw.dp25, raw.canc25);

  // YTD calculado desde dp26 (más preciso que el KPI global)
  const ytd26 = { rn:0, bk:0, ni:0, revT:0, revR:0, cm:0, cancBK:0, disp:2920, oor:0 };
  dp26.forEach(r => {
    ytd26.rn    += r.rn;    ytd26.bk   += r.bk;   ytd26.ni  += r.ni;
    ytd26.revT  += r.revT;  ytd26.revR += r.revR;  ytd26.cm  += r.cm;
    ytd26.cancBK += r.cancBK; ytd26.oor += r.oor;
  });
  ytd26.occ    = +(ytd26.rn / 2920 * 100).toFixed(2);
  ytd26.nocc   = +(ytd26.rn * 0.95 / 2920 * 100).toFixed(2);
  ytd26.adrT   = ytd26.rn > 0 ? +(ytd26.revT / ytd26.rn).toFixed(1) : 0;
  ytd26.adrR   = ytd26.rn > 0 ? +(ytd26.revR / ytd26.rn).toFixed(1) : 0;
  ytd26.nadrT  = ytd26.rn > 0 ? +((ytd26.revT - ytd26.cm) / ytd26.rn).toFixed(1) : 0;
  ytd26.nadrR  = ytd26.rn > 0 ? +((ytd26.revR - ytd26.cm) / ytd26.rn).toFixed(1) : 0;
  ytd26.los    = ytd26.rn > 0 ? +(ytd26.ni / ytd26.rn).toFixed(1) : 0;
  ytd26.nRevT  = ytd26.revT - ytd26.cm;
  ytd26.nRevR  = ytd26.revR - ytd26.cm;
  ytd26.revPAR  = +(ytd26.revT / 2920).toFixed(1);
  ytd26.nRevPAR = +(ytd26.nRevT / 2920).toFixed(1);
  ytd26.cmPct   = ytd26.revT > 0 ? +(ytd26.cm / ytd26.revT * 100).toFixed(2) : 0;
  ytd26.units   = 8;
  ytd26.cancRate = ytd26.bk > 0 ? +(ytd26.cancBK / (ytd26.bk + ytd26.cancBK) * 100).toFixed(2) : 0;

  // YTD 2025
  const ytd25 = { rn:0, bk:0, ni:0, revT:0, revR:0, cm:0, cancBK:0, disp:2920, oor:0 };
  dp25.forEach(r => { ytd25.rn+=r.rn; ytd25.bk+=r.bk; ytd25.ni+=r.ni; ytd25.revT+=r.revT; ytd25.revR+=r.revR; ytd25.cm+=r.cm; ytd25.cancBK+=r.cancBK||0; ytd25.oor+=r.oor||0; });
  ytd25.occ    = +(ytd25.rn / 2920 * 100).toFixed(2);
  ytd25.nocc   = +(ytd25.rn * 0.95 / 2920 * 100).toFixed(2);
  ytd25.adrT   = ytd25.rn > 0 ? +(ytd25.revT / ytd25.rn).toFixed(1) : 0;
  ytd25.adrR   = ytd25.rn > 0 ? +(ytd25.revR / ytd25.rn).toFixed(1) : 0;
  ytd25.nadrT  = ytd25.rn > 0 ? +((ytd25.revT - ytd25.cm) / ytd25.rn).toFixed(1) : 0;
  ytd25.nadrR  = ytd25.rn > 0 ? +((ytd25.revR - ytd25.cm) / ytd25.rn).toFixed(1) : 0;
  ytd25.los    = ytd25.rn > 0 ? +(ytd25.ni / ytd25.rn).toFixed(1) : 0;
  ytd25.nRevT  = ytd25.revT - ytd25.cm;
  ytd25.nRevR  = ytd25.revR - ytd25.cm;
  ytd25.revPAR  = +(ytd25.revT / 2920).toFixed(1);
  ytd25.nRevPAR = +(ytd25.nRevT / 2920).toFixed(1);
  ytd25.cmPct   = ytd25.revT > 0 ? +(ytd25.cm / ytd25.revT * 100).toFixed(2) : 0;
  ytd25.units   = 8;
  ytd25.cancRate = ytd25.bk > 0 ? +(ytd25.cancBK / (ytd25.bk + ytd25.cancBK) * 100).toFixed(2) : 0;

  // Pick Up
  const CTK = 'Informe Reservas Total[Create time]';
  const pu = (raw.pickup || []).map(r => ({
    d:   (r[CTK] || '').split('T')[0],
    c:   r['[Conf]'] || 0,
    x:   r['[Canc]'] || 0,
    rev: Math.round(r['[Rev]'] || 0)
  }));

  // Pick Up dimensionado (CY 31d, LY, por unidad/grupo/canal) + diario por fecha de estancia
  const FVK2='Fecha Venta[Date]', SYK='Fechas estancia[Year]', SMK='Fechas estancia[Month]', SDK='Fechas estancia[Date]';
  const _pm = (raw.pickupMonth && raw.pickupMonth[0]) ? Object.keys(raw.pickupMonth[0]) : [];
  const kUnit = _pm.find(k => k.indexOf('Tipo Habit') >= 0) || '';
  const kProp = _pm.find(k => k.indexOf('Property') >= 0) || '';
  const kCh   = _pm.find(k => k.indexOf('Source Filtro') >= 0) || '';
  const kLoc  = _pm.find(k => k.indexOf('Location') >= 0) || '';
  const kRate = _pm.find(k => k.indexOf('Rate plan') >= 0) || '';
  const kMkt  = _pm.find(k => k.indexOf('[Country]') >= 0 && k.indexOf('ISO') < 0) || '';
  const mapDim = (r) => ({
    unit: (kUnit && r[kUnit]) ? String(r[kUnit]).replace(/[()]/g,'') : '?',
    grp:  (kProp && r[kProp]) ? r[kProp] : '?',
    ch:   (kCh && r[kCh]) ? r[kCh] : 'Otros',
    loc:  (kLoc && r[kLoc]) ? r[kLoc] : '?',
    rate: (kRate && r[kRate]) ? r[kRate] : '(sin tarifa)',
    mkt:  (kMkt && r[kMkt]) ? r[kMkt] : '(s/país)'
  });
  const pickupDaily = (raw.pickupDaily || []).map(r => ({
    d:(r[FVK2]||'').split('T')[0], y:r[SYK]||0,
    bk:r['[BK]']||0, rn:r['[RN]']||0, rev:Math.round(r['[Rev]']||0),
    cbk:r['[CBK]']||0, crn:r['[CRN]']||0, crev:Math.round(r['[CRev]']||0)
  })).filter(x => x.d && x.y);
  const pickupMonth = (raw.pickupMonth || []).map(r => Object.assign({
    d:(r[FVK2]||'').split('T')[0], y:r[SYK]||0, mo:(r[SMK]||1)-1,
    bk:r['[BK]']||0, rn:r['[RN]']||0, rev:Math.round(r['[Rev]']||0), crn:r['[CRN]']||0
  }, mapDim(r))).filter(x => x.d && x.y);
  const pickupLY = (raw.pickupLY || []).map(r => Object.assign({
    d:(r[FVK2]||'').split('T')[0], y:r[SYK]||0, mo:(r[SMK]||1)-1,
    bk:r['[BK]']||0, rn:r['[RN]']||0, rev:Math.round(r['[Rev]']||0)
  }, mapDim(r))).filter(x => x.d);
  const pickupStay = (raw.pickupStay || []).map(r => ({
    d:(r[FVK2]||'').split('T')[0], sd:(r[SDK]||'').split('T')[0], rn:r['[RN]']||0, rev:Math.round(r['[Rev]']||0)
  })).filter(x => x.d && x.sd);
  const pickupStayLY = (raw.pickupStayLY || []).map(r => ({
    d:(r[FVK2]||'').split('T')[0], sd:(r[SDK]||'').split('T')[0], rn:r['[RN]']||0, rev:Math.round(r['[Rev]']||0)
  })).filter(x => x.d && x.sd);
  const _td = new Date();
  const isoToday = _td.getFullYear()+'-'+String(_td.getMonth()+1).padStart(2,'0')+'-'+String(_td.getDate()).padStart(2,'0');

  // Pace OTB en vivo (hoy en adelante): por año/mes y por día, CY + LY (mismo método un año atrás)
  const SYK2='Fechas estancia[Year]', SMK2='Fechas estancia[Month]', SDK2='Fechas estancia[Date]';
  const paceOTB = (raw.paceM || []).map(r => ({
    y:r[SYK2]||0, mo:(r[SMK2]||1)-1, rn:r['[RN]']||0, ing:Math.round(r['[ING]']||0)
  })).filter(x => x.y);
  const paceOTBLY = (raw.paceMLY || []).map(r => ({
    y:r[SYK2]||0, mo:(r[SMK2]||1)-1, rn:r['[RN]']||0, ing:Math.round(r['[ING]']||0)
  })).filter(x => x.y);
  const paceOTBD = (raw.paceD || []).map(r => ({
    sd:(r[SDK2]||'').split('T')[0], rn:r['[RN]']||0, ing:Math.round(r['[ING]']||0)
  })).filter(x => x.sd);
  const paceOTBDLY = (raw.paceDLY || []).map(r => ({
    sd:(r[SDK2]||'').split('T')[0], rn:r['[RN]']||0, ing:Math.round(r['[ING]']||0)
  })).filter(x => x.sd);

  // Construir 'pace' (formato del bloque Pace): CY/LY/ocupación, hoy en adelante
  const _ty=_td.getFullYear(), _tm=_td.getMonth(), _tday=_td.getDate(), UNITS=8;
  function capMonth(y,mo){ var dim=new Date(y,mo+1,0).getDate(); var avail=(y===_ty&&mo===_tm)?(dim-_tday+1):dim; return Math.max(0,avail)*UNITS; }
  const _lyM={}; paceOTBLY.forEach(r=>{ _lyM[r.y+'-'+r.mo]={rn:r.rn,ing:r.ing}; });
  const pace = paceOTB.map(r => { var lk=(r.y-1)+'-'+r.mo; var lm=_lyM[lk]||{rn:0,ing:0};
    return { y:r.y, mi:r.mo, m:MSH[r.mo], rn:r.rn, ly:lm.rn, rev:r.ing, revLY:lm.ing, av:capMonth(r.y,r.mo) }; });
  const paceYearAv={}; pace.forEach(p=>{ paceYearAv[p.y]=(paceYearAv[p.y]||0)+p.av; });
  // diario CY + LY (emparejado por MM-DD un año atrás)
  const _lyD={}; paceOTBDLY.forEach(r=>{ _lyD[r.sd.slice(5)]=r; });
  const paceDaily = paceOTBD.slice().sort((a,b)=>a.sd<b.sd?-1:1).map(r => { var l=_lyD[r.sd.slice(5)]||{rn:0,ing:0};
    return { d:r.sd, rn:r.rn, ly:l.rn, rev:r.ing }; });

  // Pace OTB dimensionado por propiedad/unidad/canal (para Deep Dive y slicers)
  const _pdk = (raw.paceDim && raw.paceDim[0]) ? Object.keys(raw.paceDim[0]) : [];
  const pkU = _pdk.find(k => k.indexOf('Tipo Habit') >= 0) || '';
  const pkP = _pdk.find(k => k.indexOf('Property') >= 0) || '';
  const pkC = _pdk.find(k => k.indexOf('Source Filtro') >= 0) || '';
  const pkLoc = _pdk.find(k => k.indexOf('Location') >= 0) || '';
  const pkRate = _pdk.find(k => k.indexOf('Rate plan') >= 0) || '';
  const pkMkt = _pdk.find(k => k.indexOf('[Country]') >= 0 && k.indexOf('ISO') < 0) || '';
  function mapPace(arr){ return (arr||[]).map(r => ({
    y:r[SYK2]||0, mo:(r[SMK2]||1)-1,
    grp:(pkP&&r[pkP])?r[pkP]:'?',
    unit:(pkU&&r[pkU])?String(r[pkU]).replace(/[()]/g,''):'?',
    ch:(pkC&&r[pkC])?r[pkC]:'Otros',
    loc:(pkLoc&&r[pkLoc])?r[pkLoc]:'?',
    rate:(pkRate&&r[pkRate])?r[pkRate]:'(sin tarifa)',
    mkt:(pkMkt&&r[pkMkt])?r[pkMkt]:'(s/país)',
    rn:r['[RN]']||0, ing:Math.round(r['[ING]']||0)
  })).filter(x => x.y); }
  const paceOTBdim = mapPace(raw.paceDim);
  const paceOTBdimLY = mapPace(raw.paceDimLY);
  const uniq = (a) => Array.from(new Set(a));
  const dims = {
    groups: uniq(paceOTBdim.map(r=>r.grp).filter(g=>g&&g!=='?')).sort(),
    units:  uniq(paceOTBdim.map(r=>r.unit).filter(u=>u&&u!=='?')).sort(),
    channels: uniq(paceOTBdim.concat(pickupMonth||[]).map(r=>r.ch).filter(c=>c&&c!=='Otros')).sort()
  };

  // YTD por unidad (para Pick Up por unidad/grupo y expansión de Sales)
  function mapUnit(arr){ var k=(arr&&arr[0])?Object.keys(arr[0]):[];
    var ku=k.find(x=>x.indexOf('Tipo Habit')>=0)||'';
    var kp=k.find(x=>x.indexOf('Property')>=0)||'';
    return (arr||[]).map(r=>({grp:(kp&&r[kp])?r[kp]:'?', unit:(ku&&r[ku])?String(r[ku]).replace(/[()]/g,''):'?', rn:r['[RN]']||0, bk:r['[BK]']||0, rev:Math.round(r['[RevT]']||0)})).filter(x=>x.unit&&x.unit!=='?'); }
  const dpUnit26 = mapUnit(raw.dpUnit26);
  const dpUnit25 = mapUnit(raw.dpUnit25);
  function mapChan(arr){ var k=(arr&&arr[0])?Object.keys(arr[0]):[]; var kc=k.find(x=>x.indexOf('Source Filtro')>=0)||'';
    return (arr||[]).map(r=>({ch:(kc&&r[kc])?r[kc]:'Otros', bk:r['[BK]']||0, rn:r['[RN]']||0, rev:Math.round(r['[RevT]']||0), cm:Math.round(r['[Cm]']||0)})).filter(x=>x.rn||x.bk); }
  const dpChan26 = mapChan(raw.dpChan26);
  const dpChan25 = mapChan(raw.dpChan25);
  function mapBW(arr,keyName){ var k=(arr&&arr[0])?Object.keys(arr[0]):[];
    var kd=k.find(x=> keyName==='Property'? x.indexOf('Property')>=0 : x.indexOf('Source Filtro')>=0)||'';
    return (arr||[]).map(function(r){ var o={key:(kd&&r[kd])?r[kd]:'?', n:[], r:[]};
      for(var i=0;i<7;i++){ o.n.push(r['[n'+i+']']||0); o.r.push(Math.round(r['[r'+i+']']||0)); }
      return o; }).filter(function(x){return x.key&&x.key!=='?';}); }
  const bwProp = mapBW(raw.bwProp26,'Property');
  const bwChan = mapBW(raw.bwChan26,'Source');
  // Quality (por canal y por unidad/propiedad) — filtra por alojamiento vía Habitaciones
  function _qk(arr,sub){ var k=(arr&&arr[0])?Object.keys(arr[0]):[]; return k.find(function(x){return x.indexOf(sub)>=0;})||''; }
  var _qs=raw.qualSrc||[], _qsk=_qk(_qs,'type_source_reviews');
  const qualBySource = _qs.map(function(r){ return {ch:(_qsk&&r[_qsk])?r[_qsk]:'?', nota:Math.round((r['[Nota]']||0)*100)/100, reviews:r['[Reviews]']||0}; }).filter(function(x){return x.ch&&x.ch!=='?';});
  var _qu=raw.qualUnit||[], _quu=_qk(_qu,'Tipo Habit'), _qup=_qk(_qu,'Property');
  const qualByUnit = _qu.map(function(r){ return {grp:(_qup&&r[_qup])?r[_qup]:'?', unit:(_quu&&r[_quu])?String(r[_quu]).replace(/[()]/g,''):'?', nota:Math.round((r['[Nota]']||0)*100)/100, reviews:r['[Reviews]']||0}; }).filter(function(x){return x.unit&&x.unit!=='?';});
  var _qrev=qualBySource.reduce(function(s,r){return s+r.reviews;},0)||1;
  var _qnota=qualBySource.reduce(function(s,r){return s+r.nota*r.reviews;},0)/_qrev;

  // --- Quality: score mensual (0-10) ---
  var _qm = raw.qualMonth || [];
  const qualByMonth = _qm.map(function(r){ var nota=r['[nota]']||0, cn=r['[n]']||0; return { ym: r['[YM]']||0, score: Math.round(nota*100)/100, n: cn }; }).filter(function(x){return x.ym;}).sort(function(a,b){return a.ym-b.ym;});
  // --- Quality: reseñas individuales (texto, score 0-10, fuente, unidad) ---
  function _qclean(t){ t=String(t==null?'':t).replace(/<br\s*\/?>/gi,' ').replace(/\s+/g,' ').trim(); if(t.indexOf(' - ')===0) t=t.slice(3).trim(); return t; }
  var _qr = raw.qualRev || [];
  const qualList = _qr.map(function(r){
    var d=String(r['[f]']||'').split('T')[0];
    var sc5=r['[sc]']; var sc=(sc5!=null)?Math.round(sc5*2*10)/10:null;
    var unit=String(r['[unit]']||r['[hold]']||'').replace(/[()]/g,'').trim();
    var prop=String(r['[hold]']||'').replace(/[()]/g,'').trim();
    return { s:sc, d:d, src:String(r['[src]']||''), unit:unit, prop:prop, txt:_qclean(r['[txt]']) };
  }).filter(function(x){ return x.d && x.s!=null; });
  var _qsorted = qualList.slice().sort(function(a,b){ return a.d<b.d?1:(a.d>b.d?-1:0); });
  var qualLastPos=null, qualLastNeg=null;
  for(var _i=0;_i<_qsorted.length;_i++){ var _rv=_qsorted[_i]; var _ok=_rv.txt && _rv.txt.toLowerCase().indexOf('no comments')<0;
    if(qualLastPos===null && _ok && _rv.s>8) qualLastPos=_rv;
    if(qualLastNeg===null && _ok && _rv.s<5) qualLastNeg=_rv;
    if(qualLastPos&&qualLastNeg) break; }
  const quality = { overall:Math.round(_qnota*100)/100, reviews:_qrev, bySource:qualBySource, byUnit:qualByUnit, byMonth:qualByMonth, list:qualList, lastPos:qualLastPos, lastNeg:qualLastNeg };
  // --- Booker Insights por país (periodo F26: confirmadas, estancia año actual, Conexion OK) ---
  var _bk = raw.bookerCty || [];
  var _bkk = (_bk[0]?Object.keys(_bk[0]):[]);
  var _bcty = _bkk.find(function(x){return x.indexOf('Country')>=0;}) || '';
  const booker = _bk.map(function(r){
    var iso=String((_bcty&&r[_bcty]!=null)?r[_bcty]:'').trim();
    var bk=r['[bk]']||0, rn=r['[rn]']||0, rev=Math.round(r['[rev]']||0), bwsum=r['[bwsum]']||0;
    return { iso:iso, bk:bk, rn:rn, rev:rev, adr: rn?Math.round(rev/rn*10)/10:0, abv: bk?Math.round(rev/bk*100)/100:0, los: bk?Math.round(rn/bk*100)/100:0, bw: rn?Math.round(bwsum/rn*10)/10:0 };
  }).filter(function(x){ return x.iso && x.rn>0; }).sort(function(a,b){ return b.rev-a.rev; });
  // Market Data: percentiles de mercado + ocupación por mes (del alojamiento)
  const market = (raw.market26||[]).map(function(r){ return { mo:(r['[Value]']||1)-1, p25:Math.round(r['[p25]']||0), p50:Math.round(r['[p50]']||0), p75:Math.round(r['[p75]']||0), occ:Math.round((r['[occ]']||0)*1000)/10 }; });
  // Web Analytics (GA4 + GSC) — filtran por alojamiento directo
  var _wk=(raw.waKPI&&raw.waKPI[0])?raw.waKPI[0]:{};
  function _kc(arr,sub){ var k=(arr&&arr[0])?Object.keys(arr[0]):[]; return k.find(function(x){return x.indexOf(sub)>=0;})||''; }
  var _ws=raw.waSrc||[], _wsk=_kc(_ws,'traffic_source');
  var _wd=raw.waDev||[], _wdk=_kc(_wd,'device');
  var _wq=raw.waQry||[], _wqk=_kc(_wq,'query');
  const web = {
    users:_wk['[users]']||0, pviews:_wk['[pviews]']||0,
    clicks:_wk['[clicks]']||0, impr:_wk['[impr]']||0, pos:Math.round((_wk['[pos]']||0)*10)/10,
    sources: _ws.map(function(r){return {name:(_wsk&&r[_wsk])?r[_wsk]:'(direct)', u:r['[u]']||0};}).filter(function(x){return x.u;}).sort(function(a,b){return b.u-a.u;}),
    devices: _wd.map(function(r){return {name:(_wdk&&r[_wdk])?r[_wdk]:'?', u:r['[u]']||0};}).filter(function(x){return x.u;}),
    queries: _wq.map(function(r){return {q:(_wqk&&r[_wqk])?r[_wqk]:'', c:r['[c]']||0, i:r['[i]']||0};}).filter(function(x){return x.q;}),
    reservas:_wk['[reservas]']||0,
    growth:(raw.waGrowth||[]).map(function(r){return {ym:r['[YM]']||0, v:r['[v]']||0};}).filter(function(x){return x.ym;}).sort(function(a,b){return a.ym-b.ym;}),
    dates:(raw.waDates||[]).map(function(r){return {ym:r['[YM]']||0, n:r['[n]']||0};}).filter(function(x){return x.ym;}).sort(function(a,b){return a.ym-b.ym;}),
    dur:(function(){var a=raw.waDur||[],k=_kc(a,'Group duration');return a.map(function(r){return {g:(k&&r[k]!=null&&r[k]!=='')?String(r[k]):'?', n:r['[n]']||0};}).filter(function(x){return x.g!=='?'&&x.n;});})(),
    pax:(function(){var a=raw.waPax||[],k=_kc(a,'Group pax');return a.map(function(r){return {g:(k&&r[k]!=null&&r[k]!=='')?String(r[k]):'?', n:r['[n]']||0};}).filter(function(x){return x.g!=='?'&&x.n;});})()
  };
  web.hasData = (web.users>0)||(web.pviews>0);
  // P&L: revenue (reservas) - comisiones - costes operativos (por partida, donde exista)
  var _pk=_kc(raw.plCosts,'Partida'), _ptk=_kc(raw.plCosts,'Tipo Coste');
  var plCostRows=(raw.plCosts||[]).map(function(r){ return {partida:(_pk&&r[_pk])?r[_pk]:'?', tipo:(_ptk&&r[_ptk])?r[_ptk]:'', monto:Math.round(r['[Coste]']||0)}; }).filter(function(x){return x.monto;});
  var _plRev=(ytd26&&ytd26.revT)||0, _plCom=(ytd26&&ytd26.cm)||0, _plCost=plCostRows.reduce(function(s,r){return s+r.monto;},0);
  const pl = { revenue:_plRev, commission:_plCom, costs:plCostRows, totalCost:_plCost, gop:Math.round(_plRev-_plCom-_plCost), hasCosts:plCostRows.length>0 };
  // OTB por antelación (buckets) para el Deep Dive de Pace (dimensión Antelación)
  var _pld=(raw.paceLead&&raw.paceLead[0])?raw.paceLead[0]:{};
  const paceLead = []; for(var _b=0;_b<7;_b++){ paceLead.push({bucket:_b, rn:_pld['[n'+_b+']']||0, ing:Math.round(_pld['[r'+_b+']']||0)}); }
  // Booking Window: antelaci\u00f3n (CHECK IN, nivel reserva) confirmadas vs canceladas + cancelaci\u00f3n mensual
  var _bwl=raw.bwLead||[];
  function _bwEmpty(){ return {bk:0,rn:0,rev:0}; }
  var bwLeadArr=[]; for(var _bi=0;_bi<7;_bi++){ bwLeadArr.push({bucket:_bi, conf:_bwEmpty(), canc:_bwEmpty()}); }
  _bwl.forEach(function(r){ var b=r['[B]']; if(b==null||b<0||b>6)return; var st=String(r["Informe Reservas Total[Status]"]||r['[Status]']||'').toUpperCase();
    var cell={bk:r['[bk]']||0, rn:r['[rn]']||0, rev:Math.round(r['[rev]']||0)};
    if(st.indexOf('CANCEL')>=0) bwLeadArr[b].canc=cell; else if(st.indexOf('CONFIRM')>=0) bwLeadArr[b].conf=cell; });
  var _bwlLY=raw.bwLeadLY||[]; var bwLeadLYArr=[]; for(var _bj=0;_bj<7;_bj++){ bwLeadLYArr.push({bucket:_bj, conf:_bwEmpty(), canc:_bwEmpty()}); }
  _bwlLY.forEach(function(r){ var b=r['[B]']; if(b==null||b<0||b>6)return; var st=String(r["Informe Reservas Total[Status]"]||r['[Status]']||'').toUpperCase();
    var cell={bk:r['[bk]']||0, rn:r['[rn]']||0, rev:Math.round(r['[rev]']||0)};
    if(st.indexOf('CANCEL')>=0) bwLeadLYArr[b].canc=cell; else if(st.indexOf('CONFIRM')>=0) bwLeadLYArr[b].conf=cell; });
  var _bwm=raw.bwMon||[]; var _bwPrev=year-1;
  var bwMon={}; bwMon[_bwPrev]={conf:new Array(12).fill(0),canc:new Array(12).fill(0)}; bwMon[year]={conf:new Array(12).fill(0),canc:new Array(12).fill(0)};
  _bwm.forEach(function(r){ var y=r['[Y]'], m=(r['[M]']||0)-1; if(m<0||m>11||!bwMon[y])return; var st=String(r["Informe Reservas Total[Status]"]||r['[Status]']||'').toUpperCase(); var bk=r['[bk]']||0;
    if(st.indexOf('CANCEL')>=0) bwMon[y].canc[m]+=bk; else if(st.indexOf('CONFIRM')>=0) bwMon[y].conf[m]+=bk; });
  const bw = { lead:bwLeadArr, leadLY:bwLeadLYArr, mon:bwMon, yCur:year, yPrev:_bwPrev };
  // Eventos próximos alineados a las ciudades del cliente
  var _ev=raw.eventos||[]; function _ek(sub){ var k=(_ev[0])?Object.keys(_ev[0]):[]; return k.find(function(x){return x.indexOf(sub)>=0;})||''; }
  var _ekd=_ek('Día')||_ek('a]'), _ekc=_ek('Ciudad'), _ekn=_ek('Evento Resumen'), _ekf=_ek('Festivo');
  const eventos = _ev.map(function(r){ return { d:(r[_ekd]||'').split('T')[0], city:(_ekc&&r[_ekc])?r[_ekc]:'', name:(_ekn&&r[_ekn])?r[_ekn]:'', festivo:(_ekf&&r[_ekf])?r[_ekf]:'' }; }).filter(function(x){return x.d&&x.name;});
  var _gv = raw.geo||[]; function _gk(sub){ var k=(_gv[0])?Object.keys(_gv[0]):[]; return k.find(function(x){return x.indexOf(sub)>=0;})||''; }
  var _gloc=_gk('Location'), _giso=_gk('Country ISO'), _greg=_gk('Region');
  const geo = _gv.map(function(r){ var ci=(_gloc&&r[_gloc]!=null)?String(r[_gloc]):''; var i1=(_giso&&r[_giso]!=null)?String(r[_giso]).trim():''; var i2=(_greg&&r[_greg]!=null)?String(r[_greg]).trim():''; var iso=(i1&&i1!=='-')?i1:((i2&&i2!=='-')?i2:''); return { city:ci, iso:iso, region:'' }; }).filter(function(x){return x.city||x.iso;});

  // Cancelaciones por canal
  const cancCh = (raw.cancCh || []).map(r => ({
    nm: r[CK] || 'Otros',
    c:  r['[Cancel]'] || 0
  }));

  function mapSalesDim(arr){
    var ks=(arr&&arr[0])?Object.keys(arr[0]):[];
    var ky=ks.find(function(x){return x.indexOf('Year')>=0;}), km=ks.find(function(x){return x.indexOf('Month')>=0;}),
        kp=ks.find(function(x){return x.indexOf('Property')>=0;}), ku=ks.find(function(x){return x.indexOf('Tipo Habit')>=0;}),
        kl=ks.find(function(x){return x.indexOf('Location')>=0;}), kc=ks.find(function(x){return x.indexOf('Source Filtro')>=0;}),
        kr=ks.find(function(x){return x.indexOf('Rate plan')>=0;}), kq=ks.find(function(x){return x.indexOf('Country')>=0 && x.indexOf('ISO')<0;});
    return (arr||[]).map(function(r){ return {
      y:(ky&&r[ky])||0, mo:((km&&r[km])||1)-1, grp:(kp&&r[kp]!=null)?r[kp]:'?',
      unit:(ku&&r[ku]!=null)?String(r[ku]).replace(/[()]/g,''):'?',
      loc:(kl&&r[kl]!=null)?r[kl]:'?', ch:(kc&&r[kc]!=null)?r[kc]:'?', rate:(kr&&r[kr]!=null)?r[kr]:'?', mkt:(kq&&r[kq]!=null)?r[kq]:'?',
      rn:r['[RN]']||0, bk:r['[BK]']||0, ni:r['[Ni]']||0, pax:r['[Pax]']||0,
      revR:Math.round(r['[RevR]']||0), clean:Math.round(r['[Clean]']||0), extra:Math.round(r['[Extra]']||0),
      comR:Math.round(r['[ComR]']||0), comC:Math.round(r['[ComC]']||0), bwsum:r['[BWsum]']||0
    }; }).filter(function(x){ return x.rn>0; });
  }
  function mapSalesCanc(arr){
    var ks=(arr&&arr[0])?Object.keys(arr[0]):[];
    var ky=ks.find(function(x){return x.indexOf('Year')>=0;}), km=ks.find(function(x){return x.indexOf('Month')>=0;}),
        kp=ks.find(function(x){return x.indexOf('Property')>=0;}), ku=ks.find(function(x){return x.indexOf('Tipo Habit')>=0;}),
        kl=ks.find(function(x){return x.indexOf('Location')>=0;}), kc=ks.find(function(x){return x.indexOf('Source Filtro')>=0;}),
        kr=ks.find(function(x){return x.indexOf('Rate plan')>=0;}), kq=ks.find(function(x){return x.indexOf('Country')>=0 && x.indexOf('ISO')<0;});
    return (arr||[]).map(function(r){ return {
      y:(ky&&r[ky])||0, mo:((km&&r[km])||1)-1, grp:(kp&&r[kp]!=null)?r[kp]:'?',
      unit:(ku&&r[ku]!=null)?String(r[ku]).replace(/[()]/g,''):'?',
      loc:(kl&&r[kl]!=null)?r[kl]:'?', ch:(kc&&r[kc]!=null)?r[kc]:'?', rate:(kr&&r[kr]!=null)?r[kr]:'?', mkt:(kq&&r[kq]!=null)?r[kq]:'?',
      cbk:r['[cBK]']||0, crn:r['[cRN]']||0, crev:Math.round(r['[cRev]']||0), ccom:Math.round(r['[cCom]']||0)
    }; }).filter(function(x){ return x.crn>0||x.cbk>0; });
  }
  function mapSalesDay(arr){
    var ks=(arr&&arr[0])?Object.keys(arr[0]):[];
    var kd=ks.find(function(x){return x.indexOf('Date')>=0;}), kp=ks.find(function(x){return x.indexOf('Property')>=0;}), ku=ks.find(function(x){return x.indexOf('Tipo Habit')>=0;});
    return (arr||[]).map(function(r){ var ds=String((kd&&r[kd])||'').split('T')[0]; var p=ds.split('-'); var dt=(p.length===3)?new Date(+p[0],+p[1]-1,+p[2]):null;
      return { date:ds, y:dt?dt.getFullYear():0, mo:dt?dt.getMonth():0, day:dt?dt.getDate():0, dow:dt?dt.getDay():0,
        grp:(kp&&r[kp]!=null)?r[kp]:'?', unit:(ku&&r[ku]!=null)?String(r[ku]).replace(/[()]/g,''):'?',
        rn:r['[RN]']||0, bk:r['[BK]']||0, ni:r['[Ni]']||0, pax:r['[Pax]']||0,
        revR:Math.round(r['[RevR]']||0), clean:Math.round(r['[Clean]']||0), extra:Math.round(r['[Extra]']||0),
        comR:Math.round(r['[ComR]']||0), comC:Math.round(r['[ComC]']||0), bwsum:r['[BWsum]']||0 };
    }).filter(function(x){ return x.rn>0; });
  }
  var salesDay=mapSalesDay(raw.salesDay);
  var salesDim=mapSalesDim(raw.salesDim), salesDimLY=mapSalesDim(raw.salesDimLY);
  var salesCanc=mapSalesCanc(raw.salesCanc), salesCancLY=mapSalesCanc(raw.salesCancLY);
  var _cd=raw.capDim||[]; var _cdk=_cd[0]?Object.keys(_cd[0]):[];
  var _cpk=_cdk.find(function(x){return x.indexOf('Property')>=0;}), _ctk=_cdk.find(function(x){return x.indexOf('Tipo Habit')>=0;}),
      _cyk=_cdk.find(function(x){return x.indexOf('Year')>=0;}), _cmk=_cdk.find(function(x){return x.indexOf('Month')>=0;});
  var capDimArr=_cd.map(function(r){ return { y:(_cyk&&r[_cyk])||0, mo:((_cmk&&r[_cmk])||1)-1, grp:(_cpk&&r[_cpk]!=null)?r[_cpk]:'?', unit:(_ctk&&r[_ctk]!=null)?String(r[_ctk]).replace(/[()]/g,''):'?', cap:r['[cap]']||0, blk:r['[blk]']||0 }; }).filter(function(x){return x.cap>0;});
  var _uc=raw.unitsCount||[]; var _uk=_uc[0]?Object.keys(_uc[0]):[];
  var _upk=_uk.find(function(x){return x.indexOf('Property')>=0;}), _utk=_uk.find(function(x){return x.indexOf('Tipo Habit')>=0;});
  var unitsByGroup={}, unitsByType={}, totalUnits=0;
  _uc.forEach(function(r){ var g=(_upk&&r[_upk]!=null)?r[_upk]:''; var t=(_utk&&r[_utk]!=null)?String(r[_utk]).replace(/[()]/g,''):''; var u=r['[u]']||0; if(g)unitsByGroup[g]=(unitsByGroup[g]||0)+u; if(t)unitsByType[t]=(unitsByType[t]||0)+u; totalUnits+=u; });

  var _yt=(raw.ytdToday&&raw.ytdToday[0])?raw.ytdToday[0]:null;
  var ytdToday=_yt?{ rev:Math.round(_yt['[Rev]']||0), rn:_yt['[RN]']||0, bk:_yt['[BK]']||0, ni:Math.round(_yt['[Ni]']||0),
    rev25:Math.round(_yt['[Rev25]']||0), rn25:_yt['[RN25]']||0, bk25:_yt['[BK25]']||0,
    adr:(_yt['[RN]']>0)?Math.round((_yt['[Rev]']||0)/_yt['[RN]']*10)/10:0,
    adr25:(_yt['[RN25]']>0)?Math.round((_yt['[Rev25]']||0)/_yt['[RN25]']*10)/10:0 }:null;
  var _ld=(raw.losDist&&raw.losDist[0])?raw.losDist[0]:null;
  var losDist=_ld?{ b1:_ld['[b1]']||0, b2:_ld['[b2]']||0, b3:_ld['[b3]']||0, b47:_ld['[b47]']||0, b8:_ld['[b8]']||0 }:null;
  return {
    updatedAt: new Date().toISOString(),
    year,
    salesDim, salesDimLY, salesCanc, salesCancLY, capDim: capDimArr,
    salesDay,
    ytdToday, losDist,
    units: { byGroup: unitsByGroup, byType: unitsByType, total: totalUnits },
    ytd26, ytd25,
    mesActual: {
      rev: maRev, rn: maRN, bk: maBK,
      adr: maRN > 0 ? +(maRev / maRN).toFixed(1) : 0,
      occ: +(maRN / (new Date(new Date().getFullYear(), new Date().getMonth()+1, 0).getDate() * 8) * 100).toFixed(2),
      rev25: maR25, rn25: maN25, bk25: (raw.mesActual&&raw.mesActual[0])?(raw.mesActual[0]['[BK25]']||0):0,
      adr25: maN25 > 0 ? +(maR25 / maN25).toFixed(1) : 0
    },
    dp26, dp25,
    fcPk: (function(){ var a=raw.forecastPk||[]; var k=a[0]?Object.keys(a[0]):[]; var km=k.find(function(x){return x.indexOf('Month')>=0;})||'', kp=k.find(function(x){return x.indexOf('Property')>=0;})||'', ku=k.find(function(x){return x.indexOf('Tipo Habit')>=0;})||''; var ky=k.find(function(x){return x.indexOf('Year')>=0;})||''; return a.map(function(r){ return { yr:(ky&&r[ky])||0, mo:((km&&r[km])||1)-1, grp:(kp&&r[kp])?r[kp]:'?', unit:(ku&&r[ku])?String(r[ku]).replace(/[()]/g,''):'?', otb:{rn:r['[OTBR]']||0,rev:Math.round(r['[OTBV]']||0)}, pk:{ '7':{rn:r['[P7R]']||0,rev:Math.round(r['[P7V]']||0)}, '15':{rn:r['[P15R]']||0,rev:Math.round(r['[P15V]']||0)}, '30':{rn:r['[P30R]']||0,rev:Math.round(r['[P30V]']||0)}, '45':{rn:r['[P45R]']||0,rev:Math.round(r['[P45V]']||0)} } }; }).filter(function(x){return x.unit!=='?'&&(x.otb.rn||x.pk['45'].rn);}); })(),
    meteo: (function(){ var a=raw.meteoFc||[]; var k=a[0]?Object.keys(a[0]):[]; var kd=k.find(function(x){return x.indexOf('date')>=0;})||''; return a.map(function(r){ var ds=String((kd&&r[kd])||'').split('T')[0]; return { d:ds, t:Math.round(r['[T]']||0), w:r['[W]']||'' }; }).filter(function(x){return x.d;}); })(),
    fcOtb: (function(){ var a=raw.fcOtbD||[]; var k=a[0]?Object.keys(a[0]):[]; var kd=k.find(function(x){return x.indexOf('Fecha Estancia')>=0;})||'', kp=k.find(function(x){return x.indexOf('Property')>=0;})||'', ku=k.find(function(x){return x.indexOf('Tipo Habit')>=0;})||''; var m={}; a.forEach(function(r){ var ds=String((kd&&r[kd])||'').split('T')[0]; var p=ds.split('-'); if(p.length<2)return; var yr=+p[0],mo=+p[1]-1; var gp=(kp&&r[kp])?r[kp]:'?', un=(ku&&r[ku])?String(r[ku]).replace(/[()]/g,''):'?'; var key=yr+'|'+mo+'|'+gp+'|'+un; if(!m[key])m[key]={yr:yr,mo:mo,grp:gp,unit:un,rn:0,rev:0}; m[key].rn+=r['[RN]']||0; m[key].rev+=Math.round(r['[Rev]']||0); }); return Object.keys(m).map(function(k){return m[k];}); })(),
    fcOtbDay: (function(){ var a=raw.fcOtbD||[]; var k=a[0]?Object.keys(a[0]):[]; var kd=k.find(function(x){return x.indexOf('Fecha Estancia')>=0;})||''; var m={},ord=[]; a.forEach(function(r){ var ds=String((kd&&r[kd])||'').split('T')[0]; if(!ds)return; if(!m[ds]){m[ds]={d:ds,rn:0,rev:0};ord.push(ds);} m[ds].rn+=r['[RN]']||0; m[ds].rev+=Math.round(r['[Rev]']||0); }); return ord.sort().map(function(d){return m[d];}); })(),
    pace26: aggPace(raw.pace26 || []),
    pace25: aggPace(raw.pace25 || []),
    pu,
    pickupDaily, pickupMonth, pickupLY, pickupStay, pickupStayLY,
    today: isoToday,
    pace, paceDaily, paceYearAv,
    paceOTB, paceOTBLY, paceOTBD, paceOTBDLY,
    paceOTBdim, paceOTBdimLY, dims,
    dpUnit26, dpUnit25, dpChan26, dpChan25,
    bwProp, bwChan, quality, market, web, pl, paceLead, bw, eventos, geo,
    cancCh, booker
  };
}

// ── Cómputo (completo o con presupuesto) ─────────────────────────────
const BLOB_WARM_TTL = 108000000; // 30h: el refresco diario gobierna el frescor
async function compute(year, aloj, budgetMs) {
  const token   = await getToken();
  const queries = buildQueries(year, aloj);
  const deadline = budgetMs ? Date.now() + budgetMs : 0;        // 0 = sin límite (background)
  const { out, dropped } = await runQueries(token, queries, deadline);
  const data = processData(out, year);
  data.__complete = (dropped === 0);                            // true solo si NO faltó ninguna consulta
  data.__refreshAt = 0;
  return data;
}
// Precálculo COMPLETO (sin límite de tiempo) -> caché compartida. Lo usa la función background.
async function warmClient(year, aloj, force) {
  const key = `${aloj}|${year}`;
  if (!force) {
    const cur = await blobGet(key);
    if (cur && cur.data && cur.data.__complete) {
      const token = await getToken();
      const lastRefresh = await getLastRefreshMs(token);
      if (lastRefresh > 0) {
        if ((cur.pbiRefreshAt || 0) >= lastRefresh) return cur.data;        // ya tiene el último refresco de PBI
      } else if (Date.now() - (cur.writtenAt || 0) < 1200000) {
        return cur.data;                                                     // fallback: cacheado hace <20 min
      }
    }
  }
  const data = await compute(year, aloj, 0);
  if (data.__complete) await blobSet(key, { exp: Date.now() + BLOB_WARM_TTL, writtenAt: Date.now(), pbiRefreshAt: data.__refreshAt || 0, data });
  return data;
}
// Dispara el cálculo completo en segundo plano (background function, hasta 15 min) y no espera.
function triggerBackground(aloj, year) {
  try {
    const base = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || '';
    if (!base) return;
    fetch(base + '/.netlify/functions/pbi-data-background?alojamiento=' + encodeURIComponent(aloj) + '&year=' + year).catch(function(){});
  } catch (e) {}
}
module.exports.compute = compute;
module.exports.getToken = getToken;
module.exports.warmClient = warmClient;
module.exports.blobGet = blobGet;
module.exports.blobSet = blobSet;

// ── Handler principal ────────────────────────────────────────────────
exports.handler = async function(event, context) {
  // CORS — permite que el front de Netlify llame a esta function
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'max-age=300'   // cache 5 min
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const year = parseInt(event.queryStringParameters?.year) || new Date().getFullYear();
    const aloj = (String(event.queryStringParameters?.alojamiento || 'AB').replace(/[^A-Za-z0-9&\-_ |]/g,'').slice(0,800).toUpperCase()) || 'AB';  // normaliza may/min -> coincide con la caché

    // Diagnóstico: ?diag=1 -> muestra el paso y el error EXACTO de la caché (Blobs)
    if (event.queryStringParameters?.diag === '1') {
      const sid = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
      const tok = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
      const r = { step: 'start', hasSiteID: !!sid, hasToken: !!tok };
      try {
        r.step = 'import';   const m = await import('@netlify/blobs');           r.import = 'ok';
        const opts = { name: 'pbi-cache' }; if (sid && tok) { opts.siteID = sid; opts.token = tok; }
        r.step = 'getStore'; const st = m.getStore(opts);                        r.getStore = 'ok';
        r.step = 'write';    await st.setJSON('__diag', { t: Date.now() });      r.write = 'ok';
        r.step = 'read';     const v = await st.get('__diag', { type: 'json' }); r.read = v ? 'ok' : 'null';
        r.blobs = 'OK';
      } catch (e) { r.blobs = 'fail'; r.error = String((e && e.name) || '') + ': ' + String((e && e.message) || e); }
      return { statusCode: 200, headers: Object.assign({}, headers, { 'Cache-Control': 'no-store' }), body: JSON.stringify(r) };
    }
    const cacheKey = `${aloj}|${year}`;
    const force = event.queryStringParameters?.warm === '1';
    // SIN caché de CDN (evita que se sirva un cliente por otro). La velocidad la da la caché Blobs.
    function ok(d) {
      const h = Object.assign({}, headers, { 'Cache-Control': 'no-store' });
      return { statusCode: 200, headers: h, body: JSON.stringify(d) };
    }

    // 1) Caché COMPARTIDA (Blobs) con datos COMPLETOS de ESTE cliente -> sirve al INSTANTE (flash).
    //    Stale-while-revalidate: si está algo vieja, igual la sirve YA y refresca en segundo plano.
    const blobShared = force ? null : await blobGet(cacheKey);
    if (blobShared && blobShared.data && blobShared.data.__complete && blobShared.exp > Date.now()) {
      return ok(blobShared.data);   // caché FRESCA -> flash. Si expiró, abajo recalcula y actualiza.
    }

    // 2) No hay caché. Calcula EN VIVO con presupuesto (la función principal sí puede escribir Blobs),
    //    deduplicando peticiones simultáneas del mismo cliente.
    let result = null;
    const inflight = RESP_CACHE.get(cacheKey);
    if (!force && inflight && inflight.exp > Date.now()) {
      try { result = await inflight.promise; } catch (e) { result = null; }
    } else {
      const p = compute(year, aloj, BUDGET_MS);
      RESP_CACHE.set(cacheKey, { exp: Date.now() + 30000, promise: p });
      try { result = await p; } catch (e) { console.error('[compute]', e.message); result = null; }
    }
    // 2a) Completo -> GUARDA en caché (Blobs) y sirve. La próxima carga ya es flash para todos.
    if (result && result.__complete) {
      blobSet(cacheKey, { exp: Date.now() + BLOB_TTL_MS, writtenAt: Date.now(), pbiRefreshAt: 0, data: result });
      return ok(result);
    }
    // 2b) No completó (cliente muy grande en 10s): sirve el último COMPLETO si existe (aunque sea viejo).
    const anyBlob = blobShared || await blobGet(cacheKey);
    if (anyBlob && anyBlob.data && anyBlob.data.__complete) return ok(anyBlob.data);
    // 2c) Nada todavía: intenta el segundo plano (por si el plan lo soporta) y responde 'pending'.
    triggerBackground(aloj, year);
    return ok({ pending: true, aloj: aloj, year: year });

  } catch (err) {
    console.error('[pbi-data]', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
