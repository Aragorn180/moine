'use strict';
// Moine — garde-fou de discipline du plan « Candle Daily ».
// Tout est stocké en local (localStorage) sur l'iPhone ; aucun serveur.

const KEY = 'moine.v1';
const DEFAULTS = { capital: 50000, riskA: 0.5, riskB: 0.25, cooldownMin: 30, maxTrades: 1 };
// Narrative hebdo obligatoire sur ces trois actifs ; seuls EURUSD et BTCUSDT se tradent (DXY = lecture).
const ASSETS = ['DXY', 'EURUSD', 'BTCUSDT'];
const PAIRS = ['EURUSD', 'BTCUSDT'];
const UNLOCK = 'MOINE|'; // préfixe du jeton lu par le raccourci MetaTrader
const QUARTERS = [['Q1', 17], ['Q2', 21], ['Q3', 1], ['Q4', 5], ['Q5', 9], ['Q6', 13]];
const HP = new Set([1, 2, 3, 4]); // Q2..Q5 : ouvertures 21h, 1h, 5h, 9h NY
const BREAKS = ['SL déplacé', 'Sortie anticipée', 'Surtaille', 'Ré-entrée', 'Hors plan'];
const STOPS_A = [
  'Mon biais HTF n\'est pas tranché (« 2 options », « les deux me vont ») ?',
  'Je trade contre un CRT que j\'ai moi-même noté (en l\'appelant « trap ») ?',
  'J\'ai écrit moi-même que ce n\'est pas HP, ou « ça peut être un trap » ?',
  'Mon analyse est vide ou recopiée d\'un autre trade ?',
  'Une news rouge (NFP, CPI, FOMC) tombe pendant le trade ?',
  'Je prends ce trade parce que je n\'ai rien eu depuis longtemps ?',
];

// ---------- état ----------
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && s.settings) return s;
  } catch (e) {}
  return { settings: { ...DEFAULTS }, pending: null, weeks: {}, trades: [], events: [], cooldownUntil: 0 };
}
let S = load();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { alert('Sauvegarde impossible : ' + e.message); }
}

// ---------- temps (New York) ----------
const NYF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
function ny(t = Date.now()) {
  const p = Object.fromEntries(NYF.formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, h: +p.hour, min: +p.minute };
}
// Le jour de trading commence à 17h NY (ouverture de la bougie daily).
const tradingDay = (t = Date.now()) => ny(t + 7 * 3600e3).date;
const dow = d => new Date(d + 'T12:00:00Z').getUTCDay();
const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
// Semaine = le lundi de trading ; le week-end prépare la semaine suivante.
function weekKey(d = tradingDay()) {
  const w = dow(d);
  return w === 6 ? addDays(d, 2) : w === 0 ? addDays(d, 1) : addDays(d, -(w - 1));
}
const forexClosed = (d = tradingDay()) => dow(d) === 6 || dow(d) === 0;
const quarter = (h = ny().h) => Math.floor(((h - 17 + 24) % 24) / 4);
const hhmm = t => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const frDay = d => new Date(d + 'T12:00:00Z').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

// ---------- réglages différés ----------
// Un changement de réglage ne prend effet qu'au jour de trading suivant : pas de surtaille à chaud.
function applyPending() {
  if (S.pending && tradingDay() >= S.pending.from) {
    S.settings = { ...S.settings, ...S.pending.settings };
    S.pending = null;
    save();
  }
}

// ---------- narrative ----------
const assetDone = a => a && a.bias && (a.bias === 'Observation' || (a.dol && a.key));
const narrative = (k = weekKey()) => S.weeks[k]?.assets || {};
const missingAssets = (k = weekKey()) => ASSETS.filter(x => !assetDone(narrative(k)[x]));
const biasOf = pair => narrative()[pair]?.bias;

// Fin de validité du déverrouillage MT5 : dimanche 17h NY qui ouvre la semaine suivante.
function unlockExpiry(k = weekKey()) {
  const d = addDays(k, 6);
  for (const off of ['-04:00', '-05:00']) {
    const t = Date.parse(`${d}T17:00:00${off}`);
    if (ny(t).h === 17) return t;
  }
}
// Heure locale de l'iPhone, format que Raccourcis sait relire sans ambiguïté.
function unlockToken() {
  const x = new Date(unlockExpiry()), p = n => String(n).padStart(2, '0');
  return `${UNLOCK}${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
}
async function copyUnlock() {
  try { await navigator.clipboard.writeText(unlockToken()); return true; } catch (e) { return false; }
}

// ---------- statut du jour ----------
const tradesOn = d => S.trades.filter(t => t.day === d);
function status() {
  const now = Date.now(), d = tradingDay(), miss = missingAssets();
  if (miss.length)
    return { ok: false, cls: 'no', title: 'MT5 bloqué.', detail: `Narrative de la semaine à faire : ${miss.join(', ')}.`, go: 'week' };
  if (S.cooldownUntil > now)
    return { ok: false, cls: 'wait', title: 'Respire.', detail: `Plan refusé. Nouvel essai possible à ${hhmm(S.cooldownUntil)}.` };
  if (PAIRS.every(p => biasOf(p) === 'Observation'))
    return { ok: false, cls: 'no', title: 'Semaine d\'observation.', detail: 'Tu as décidé de regarder cette semaine. Tu regardes.' };
  if (tradesOn(d).length >= S.settings.maxTrades)
    return { ok: false, cls: 'no', title: 'Trade du jour pris.', detail: 'Rien d\'autre aujourd\'hui. Prochaine daily à 17h NY.' };
  const q = quarter();
  if (!HP.has(q))
    return { ok: false, cls: 'wait', title: 'Hors fenêtre.', detail: q === 5
      ? 'Après-midi NY : plus de setup. Prochaine ouverture HP à 21h NY.'
      : 'Q1 : on attend la purge à l\'ouverture de 21h NY.' };
  if (forexClosed(d))
    return { ok: true, cls: 'wait', title: 'Forex fermé.', detail: 'BTCUSDT seulement.' };
  return { ok: true, cls: 'ok', title: 'Fenêtre ouverte.', detail: `${S.settings.maxTrades} trade max aujourd'hui.` };
}

// ---------- rendu ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let tab = 'today';
let gate = null; // questionnaire en cours

function render() {
  applyPending();
  $('#tabs').classList.toggle('hidden', !!gate);
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('#view').innerHTML = gate ? renderGate() : VIEWS[tab]();
}

function quartersStrip() {
  const q = quarter();
  return `<div class="quarters">${QUARTERS.map(([n, h], i) =>
    `<div class="${i === q ? 'now' : HP.has(i) ? 'hp' : ''}">${n}<br>${h}h</div>`).join('')}</div>`;
}

const VIEWS = {
  today() {
    const st = status(), d = tradingDay(), n = ny(), nar = narrative(), open = !missingAssets().length;
    const todays = tradesOn(d);
    return `
      <h1>Moine</h1>
      <p class="sub">${frDay(d)} · ${String(n.h).padStart(2, '0')}:${String(n.min).padStart(2, '0')} NY</p>
      <div class="card">
        <div class="status"><span class="dot ${st.cls}"></span><span class="big">${st.title}</span></div>
        <p class="dim" style="margin:8px 0 0">${st.detail}</p>
        ${quartersStrip()}
      </div>
      ${st.ok ? '<button class="primary" data-act="gate">Je veux entrer</button>'
        : st.go ? `<button class="primary" data-tab="${st.go}">Écrire la narrative</button>` : ''}
      ${open ? `<div style="margin-top:10px"><button data-act="unlock">Déverrouiller MT5</button></div>
        <p class="dim small" style="margin:8px 4px 0">Valable jusqu'à dimanche ${hhmm(unlockExpiry())}.</p>` : ''}
      <h2>Semaine</h2><div class="card">${ASSETS.map(x => `
        <div class="row"><span class="dim">${x}</span>${assetDone(nar[x])
          ? `<b>${esc(nar[x].bias)}</b>` : '<span class="tag r">À faire</span>'}</div>`).join('')}</div>
      ${todays.length ? `<h2>Aujourd'hui</h2>${todays.map(tradeCard).join('')}` : ''}
      <h2>Règles</h2>
      <div class="card small dim">
        Daily tranchée (OHLC → short, OLHC → long) dans le sens de la DOL.<br>
        Purge à l'ouverture d'une H4 HP (21h, 1h, 5h, 9h NY), sur le key level, reclose.<br>
        Entrée M15 après la purge, jamais d'ordre posé avant. RR ≥ 2.<br>
        A = 4/4 → ${S.settings.riskA} % · B = 3/4 → ${S.settings.riskB} % · sinon rien.
      </div>`;
  },

  week() {
    const k = weekKey(), nar = narrative(k);
    // Un actif fait est figé une fois la semaine lancée ; on peut toujours compléter ceux qui manquent.
    const frozen = x => assetDone(nar[x]) && !forexClosed();
    const ph = { DXY: ['old high W 99.80', 'FVG D 98.95'], EURUSD: ['old low W 1.1520', 'OB D 1.1610'], BTCUSDT: ['old high W 112 000', 'FVG D 106 500'] };
    const past = Object.keys(S.weeks).filter(x => x !== k).sort().reverse().slice(0, 8);
    return `
      <h1>Semaine</h1>
      <p class="sub">Semaine du ${frDay(k)} · Y → 6M → 3M → M → W. Pas aligné → Observation.</p>
      ${ASSETS.map(x => frozen(x) ? `<h2>${x}</h2><div class="card">
          <div class="row"><span class="dim">Biais</span><b>${esc(nar[x].bias)}</b></div>
          ${nar[x].bias !== 'Observation' ? `<div class="row"><span class="dim">DOL</span><b>${esc(nar[x].dol)}</b></div>
          <div class="row"><span class="dim">Key level</span><b>${esc(nar[x].key)}</b></div>` : ''}</div>`
      : `<h2>${x}</h2><div class="card" data-asset="${x}">
          <div class="choices three">${['Long', 'Short', 'Observation'].map(b =>
            `<button data-act="bias" data-v="${b}" class="${nar[x]?.bias === b ? 'on' : ''}">${b}</button>`).join('')}</div>
          <label>Draw on liquidity</label><input class="dol" value="${esc(nar[x]?.dol)}" placeholder="ex. ${ph[x][0]}">
          <label>Key level HTF</label><input class="key" value="${esc(nar[x]?.key)}" placeholder="ex. ${ph[x][1]}">
        </div>`).join('')}
      ${ASSETS.some(x => !frozen(x)) ? `<label>Notes</label><textarea id="notes">${esc(S.weeks[k]?.notes)}</textarea>
        <div style="margin-top:16px"><button class="primary" data-act="saveWeek">Enregistrer</button></div>`
      : '<p class="dim small" style="margin-top:12px">Narrative figée jusqu\'au week-end.</p>'}
      ${past.length ? `<h2>Semaines passées</h2><div class="card">${past.map(p =>
        `<div class="row"><span class="dim">${p}</span><b>${ASSETS.map(x => `${x} ${esc(narrative(p)[x]?.bias?.[0] || '·')}`).join(' · ')}</b></div>`).join('')}</div>` : ''}`;
  },

  journal() {
    const done = S.trades.filter(t => t.r != null);
    const totalR = done.reduce((a, t) => a + t.r, 0);
    const clean = done.filter(t => !t.broke.length).length;
    const skips = S.events.filter(e => e.type === 'skip' || e.type === 'fail').length;
    return `
      <h1>Journal</h1>
      <p class="sub">La discipline se compte, le PnL suit.</p>
      <div class="card">
        <div class="row"><span class="dim">Trades</span><b>${S.trades.length}</b></div>
        <div class="row"><span class="dim">Résultat</span><b>${totalR >= 0 ? '+' : ''}${totalR.toFixed(2)} R</b></div>
        <div class="row"><span class="dim">Plan respecté</span><b>${done.length ? Math.round(100 * clean / done.length) + ' %' : '—'}</b></div>
        <div class="row"><span class="dim">Trades évités</span><b>${skips}</b></div>
        <div class="row"><span class="dim">Série propre</span><b>${cleanStreak()} trade${cleanStreak() > 1 ? 's' : ''}</b></div>
      </div>
      <h2>Trades</h2>
      ${S.trades.length ? S.trades.slice().reverse().map(tradeCard).join('') : '<p class="dim">Aucun trade.</p>'}
      <h2>Refus et abstentions</h2>
      <div class="card">${S.events.slice(-15).reverse().map(e =>
        `<div class="row small"><span class="dim">${e.day}</span><span>${esc(e.reason)}</span></div>`).join('') || '<p class="dim">Rien.</p>'}</div>`;
  },

  settings() {
    const s = S.settings, p = S.pending?.settings || {};
    const field = (k, label, step) => `<label>${label}${p[k] != null ? ` <span class="tag o">→ ${p[k]} demain</span>` : ''}</label>
      <input type="number" inputmode="decimal" step="${step}" id="s_${k}" value="${s[k]}">`;
    return `
      <h1>Réglages</h1>
      <p class="sub">Tout changement prend effet au jour de trading suivant.</p>
      <div class="card">
        ${field('capital', 'Capital (USD)', '100')}
        ${field('riskA', 'Risque grade A (%)', '0.05')}
        ${field('riskB', 'Risque grade B (%)', '0.05')}
        ${field('maxTrades', 'Trades max par jour', '1')}
        ${field('cooldownMin', 'Pause après un refus (min)', '5')}
        <div style="margin-top:16px"><button class="primary" data-act="saveSettings">Programmer pour demain</button></div>
      </div>
      <h2>Bloquer MetaTrader</h2>
      <div class="card small">
        <p>MT5 s'ouvre seulement si les narratives DXY, EURUSD et BTCUSDT sont faites. « Déverrouiller MT5 » copie un jeton valable jusqu'au dimanche 17h NY ; le raccourci le lit.</p>
        <p>Raccourcis → Automatisation → <b>+</b> → <b>App</b> → MetaTrader 5 → <b>Est ouverte</b> → <b>Exécuter immédiatement</b> → Nouveau raccourci vide. Actions dans l'ordre :</p>
        <ol style="padding-left:20px;margin:0 0 12px">
          <li><b>Obtenir le presse-papiers</b></li>
          <li><b>Si</b> Presse-papiers <b>commence par</b> <code>MOINE|</code> :<br><b>Enregistrer le fichier</b> Presse-papiers → dossier Raccourcis, « Demander où » désactivé, sous-chemin <code>moine.txt</code>, « Remplacer » activé. <b>Fin si</b>.</li>
          <li><b>Obtenir le fichier du dossier</b> Raccourcis, <code>moine.txt</code>, « Erreur si introuvable » désactivé.</li>
          <li><b>Remplacer le texte</b> <code>MOINE|</code> par rien dans Fichier.</li>
          <li><b>Obtenir les dates de l'entrée</b> Texte remplacé.</li>
          <li><b>Si</b> Dates <b>est après</b> Date actuelle : rien. <b>Sinon</b> : <b>Afficher la notification</b> « MT5 bloqué : narratives dans Moine », puis <b>Aller à l'écran d'accueil</b>. <b>Fin si</b>.</li>
        </ol>
        <p class="dim" style="margin:0">Au premier lancement, autorise toujours l'accès au presse-papiers.</p>
      </div>
      <h2>Données</h2>
      <div class="stack">
        <button data-act="export">Exporter (JSON)</button>
        <button data-act="import">Importer</button>
        <button class="danger" data-act="reset">Tout effacer</button>
      </div>
      <p class="dim small" style="margin-top:16px">Données stockées sur cet iPhone uniquement. Exporte de temps en temps.</p>`;
  },
};

function tradeCard(t) {
  const res = t.r == null
    ? `<div style="margin-top:12px"><button data-act="result" data-id="${t.id}">Saisir le résultat</button></div>`
    : `<div class="row"><span class="dim">Résultat</span><b>${t.r >= 0 ? '+' : ''}${t.r} R</b></div>
       <div class="row"><span class="dim">Plan</span>${t.broke.length
         ? `<span class="tag r">${t.broke.map(esc).join(', ')}</span>` : '<span class="tag g">Respecté</span>'}</div>`;
  return `<div class="card ticket">
    <div class="row"><b>${t.pair} ${t.dir === 'long' ? '↑ Long' : '↓ Short'}</b><span class="tag">Grade ${t.grade} · ${t.risk} %</span></div>
    <div class="row"><span class="dim">${t.day}</span><span class="dim">SL ${t.stop} · TP ${t.tp} · ${t.size}</span></div>
    ${res}</div>`;
}

function cleanStreak() {
  let n = 0;
  for (const t of S.trades.slice().reverse()) {
    if (t.r == null) continue;
    if (t.broke.length) break;
    n++;
  }
  return n;
}

// ---------- questionnaire d'entrée ----------
// Une question par écran : pas de « tout cocher » réflexe.
function gateSteps() {
  const closed = forexClosed(), pair = gate?.a?.pair, a = narrative()[pair] || {};
  const yn = (q, failOn, reason, onPass) => ({ kind: 'yn', q, failOn, reason, onPass });
  return [
    ...STOPS_A.map((q, i) => yn(q, 'oui', `Stop A${i + 1}`)),
    { kind: 'pick', q: 'Paire ?', key: 'pair',
      opts: PAIRS.filter(p => (!closed || p === 'BTCUSDT') && biasOf(p) !== 'Observation') },
    { kind: 'pick', q: `La daily ${pair || ''} d'aujourd'hui ?`, key: 'profile', opts: ['OHLC', 'OLHC', 'Pas tranché'],
      check: v => v === 'Pas tranché' ? 'Daily pas tranchée'
        : (v === 'OHLC' ? 'Short' : 'Long') !== a.bias ? `Daily ${v} contre le biais ${String(a.bias).toLowerCase()} ${pair} de la semaine` : null },
    yn('La purge est faite, nette, une seule — et je n\'ai posé aucun ordre avant ?', 'non', 'Purge pas faite ou ordre posé avant'),
    yn('La purge s\'est faite à l\'ouverture d\'une H4 HP (21h, 1h, 5h, 9h NY) et a reclose ?', null, null, 'hp'),
    yn(`C'est sur le key level de la semaine${a.key ? ` (${esc(a.key)})` : ''} ?`, null, null, 'kl'),
    yn(pair === 'EURUSD' ? 'SMT : le DXY n\'a pas clôturé au-delà de son extrême ?' : 'SMT : ETH n\'a pas clôturé au-delà de son extrême ?', null, null, 'smt'),
    { kind: 'grade' },
    { kind: 'numbers' },
    yn('SL derrière l\'extrême de la purge + marge (pas au pip) ?', 'non', 'SL mal placé'),
    yn('TP1 (50 % du CRT), TP2 et BE sont écrits avant d\'entrer ?', 'non', 'Sortie pas écrite'),
    yn('Je suis calme ou focus — pas fatigué, pas anxieux, pas en rattrapage ?', 'non', 'État émotionnel'),
    { kind: 'oath' },
    { kind: 'ticket' },
  ];
}

function startGate() { gate = { i: 0, a: { hp: false, kl: false, smt: false } }; render(); }

function fail(reason) {
  const now = Date.now();
  S.events.push({ ts: now, day: tradingDay(), type: 'fail', reason });
  S.cooldownUntil = now + S.settings.cooldownMin * 60e3;
  save();
  gate = { done: 'fail', reason };
  render();
}

function next() { gate.i++; render(); }

function grade(a) {
  const n = 1 + a.hp + a.kl + a.smt; // la daily tranchée compte pour 1
  return n === 4 ? 'A' : n === 3 ? 'B' : null;
}

function sizing(a) {
  const risk = a.grade === 'A' ? S.settings.riskA : S.settings.riskB;
  const usd = S.settings.capital * risk / 100;
  // Forex coté USD : 10 $ par pip pour 1 lot. BTC : stop en $, taille en BTC.
  const size = a.pair === 'BTCUSDT'
    ? `${(usd / a.stop).toFixed(4)} BTC`
    : `${(Math.floor(usd / (a.stop * 10) * 100) / 100).toFixed(2)} lot`;
  return { risk, usd, size };
}

function renderGate() {
  if (gate.done === 'fail') return `
    <h1>Pas de trade.</h1>
    <p class="sub">${esc(gate.reason)}</p>
    <div class="card"><p>Tu viens de protéger ton compte. Le marché sera là demain.</p>
    <p class="dim small" style="margin:0">Nouvel essai possible à ${hhmm(S.cooldownUntil)}.</p></div>
    <button class="primary" data-act="closeGate">OK</button>`;
  if (gate.done === 'skip') return `
    <h1>Bien.</h1><p class="sub">Ne pas trader est une position.</p>
    <button class="primary" data-act="closeGate">OK</button>`;
  if (gate.done === 'in') return `
    <h1>En position.</h1><p class="sub">Laisse le plan travailler. Pas de SL déplacé.</p>
    <button class="primary" data-act="closeGate">OK</button>`;

  const steps = gateSteps(), st = steps[gate.i], a = gate.a;
  const head = `<div class="progress"><i style="width:${100 * gate.i / (steps.length - 1)}%"></i></div>`;
  const quit = '<button style="margin-top:24px" data-act="abandon">Je n\'entre pas</button>';

  if (st.kind === 'yn') return `${head}<p class="q">${st.q}</p>
    <div class="pair"><button data-act="yn" data-v="oui">Oui</button><button data-act="yn" data-v="non">Non</button></div>${quit}`;
  if (st.kind === 'pick') return `${head}<p class="q">${st.q}</p>
    <div class="choices">${st.opts.map(o => `<button data-act="pick" data-v="${o}">${o}</button>`).join('')}</div>${quit}`;
  if (st.kind === 'grade') {
    const g = grade(a);
    if (!g) { setTimeout(() => fail('Grade C : moins de 3 critères sur 4'), 0); return ''; }
    a.grade = g;
    return `${head}<p class="dim">Grade</p><div class="grade">${g}</div>
      <p class="sub" style="margin-top:12px">Risque ${g === 'A' ? S.settings.riskA : S.settings.riskB} % du capital.</p>
      <button class="primary" data-act="next">Continuer</button>${quit}`;
  }
  if (st.kind === 'numbers') {
    const unit = a.pair === 'BTCUSDT' ? '$' : 'pips';
    return `${head}<p class="q">Les chiffres.</p>
      <label>Stop (${unit})</label><input id="n_stop" type="number" inputmode="decimal" step="any">
      <label>TP2 — distance (${unit})</label><input id="n_tp" type="number" inputmode="decimal" step="any">
      <label>Spread actuel (${unit})</label><input id="n_spread" type="number" inputmode="decimal" step="any">
      <div style="margin-top:20px"><button class="primary" data-act="numbers">Vérifier</button></div>${quit}`;
  }
  if (st.kind === 'oath') return `${head}<p class="q">Écris : « je respecte mon stop »</p>
    <input id="oath" autocomplete="off" autocapitalize="off">
    <div style="margin-top:20px"><button class="primary" data-act="oath">Valider</button></div>${quit}`;
  if (st.kind === 'ticket') {
    const z = sizing(a);
    return `<h1>Ticket</h1><p class="sub">Exactement ça. Rien de plus.</p>
      <div class="card ticket">
        <div class="row"><span class="dim">Paire</span><b>${a.pair}</b></div>
        <div class="row"><span class="dim">Sens</span><b>${a.dir === 'long' ? '↑ Long' : '↓ Short'}</b></div>
        <div class="row"><span class="dim">Grade</span><b>${a.grade} · ${z.risk} %</b></div>
        <div class="row"><span class="dim">Risque</span><b>${z.usd.toFixed(0)} $</b></div>
        <div class="row"><span class="dim">Taille</span><b>${z.size}</b></div>
        <div class="row"><span class="dim">Stop / TP2</span><b>${a.stop} / ${a.tp}</b></div>
        <div class="row"><span class="dim">RR</span><b>${(a.tp / a.stop).toFixed(2)}</b></div>
        <div class="row"><span class="dim">TP1</span><b>50 % du CRT, moitié de la taille</b></div>
      </div>
      <div class="stack"><button class="primary" data-act="enter">J'entre</button>
      <button data-act="abandon">Je n'entre pas</button></div>`;
  }
  return '';
}

// ---------- actions ----------
const ACTIONS = {
  gate: startGate,
  next,
  closeGate() { gate = null; tab = 'today'; render(); },
  abandon() {
    S.events.push({ ts: Date.now(), day: tradingDay(), type: 'skip', reason: 'Abstention volontaire' });
    save(); gate = { done: 'skip' }; render();
  },
  yn(b) {
    const st = gateSteps()[gate.i], v = b.dataset.v;
    if (st.failOn && v === st.failOn) return fail(st.reason);
    if (st.onPass) gate.a[st.onPass] = v === 'oui';
    next();
  },
  pick(b) {
    const st = gateSteps()[gate.i], v = b.dataset.v;
    const err = st.check?.(v);
    if (err) return fail(err);
    gate.a[st.key] = v;
    if (st.key === 'profile') gate.a.dir = v === 'OHLC' ? 'short' : 'long';
    next();
  },
  numbers() {
    const stop = +$('#n_stop').value, tp = +$('#n_tp').value, spread = +$('#n_spread').value;
    if (!(stop > 0 && tp > 0 && spread >= 0) || $('#n_spread').value === '') return alert('Remplis les trois champs.');
    if (tp / stop < 2) return fail(`RR ${(tp / stop).toFixed(2)} < 2`);
    if (spread >= 0.15 * stop) return fail(`Spread ${spread} ≥ 15 % du stop`);
    Object.assign(gate.a, { stop, tp, spread });
    next();
  },
  oath() {
    const v = $('#oath').value.trim().toLowerCase().replace(/[«»"]/g, '').trim();
    if (v !== 'je respecte mon stop') return alert('Écris la phrase exactement.');
    next();
  },
  enter() {
    const a = gate.a, z = sizing(a);
    S.trades.push({ id: Date.now().toString(36), ts: Date.now(), day: tradingDay(), pair: a.pair, dir: a.dir,
      grade: a.grade, risk: z.risk, stop: a.stop, tp: a.tp, size: z.size, r: null, broke: [] });
    save(); gate = { done: 'in' }; render();
  },
  result(b) {
    const t = S.trades.find(x => x.id === b.dataset.id);
    const r = parseFloat((prompt('Résultat en R (ex. 2.5, 0, -1) :') || '').replace(',', '.'));
    if (isNaN(r)) return;
    const broke = [];
    for (const k of BREAKS) if (confirm(`As-tu fait : « ${k} » ?`)) broke.push(k);
    if (!confirm(`Enregistrer ${r} R${broke.length ? ' — règles cassées : ' + broke.join(', ') : ' — plan respecté'} ? Ce sera définitif.`)) return;
    t.r = r; t.broke = broke; save(); render();
  },
  bias(b) {
    b.parentNode.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  },
  async saveWeek() {
    const k = weekKey(), assets = { ...narrative(k) };
    // On enregistre ce qui est rempli ; un actif incomplet reste « à faire » et garde MT5 bloqué.
    for (const card of document.querySelectorAll('[data-asset]')) {
      const x = card.dataset.asset, bias = card.querySelector('button.on')?.dataset.v;
      const dol = card.querySelector('.dol').value.trim(), key = card.querySelector('.key').value.trim();
      if (bias || dol || key) assets[x] = { bias, dol, key };
    }
    const dx = assets.DXY?.bias, eu = assets.EURUSD?.bias;
    if (dx && eu && dx !== 'Observation' && dx === eu)
      return alert(`DXY ${dx} et EURUSD ${eu} : incohérent. Le DXY et l'EURUSD vont en sens inverse.`);
    S.weeks[k] = { ...S.weeks[k], assets, notes: $('#notes').value.trim(), ts: Date.now() };
    save();
    const miss = missingAssets(k);
    if (miss.length) { alert(`Enregistré. Reste à faire : ${miss.join(', ')} (biais, DOL et key level).`); return render(); }
    const copied = await copyUnlock();
    alert(copied ? 'Narratives faites. MT5 déverrouillé : jeton copié, ouvre MT5.' : 'Narratives faites. Touche « Déverrouiller MT5 » sur l\'accueil.');
    tab = 'today'; render();
  },
  async unlock() {
    alert(await copyUnlock() ? 'Jeton copié. Ouvre MT5 maintenant.' : 'Copie impossible : réessaie.');
  },
  saveSettings() {
    const next = {};
    for (const k of Object.keys(DEFAULTS)) {
      const v = +$('#s_' + k).value;
      if (!(v > 0)) return alert('Valeur invalide.');
      if (v !== S.settings[k]) next[k] = v;
    }
    if (next.riskA > 1 || next.riskB > 1) return alert('Risque max 1 % par trade.');
    // Premier réglage (aucun trade ni refus encore) : appliqué tout de suite.
    const fresh = !S.trades.length && !S.events.length;
    if (fresh) { S.settings = { ...S.settings, ...next }; S.pending = null; }
    else S.pending = Object.keys(next).length ? { settings: next, from: addDays(tradingDay(), 1) } : null;
    save(); render();
  },
  async export() {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
    const file = new File([blob], `moine-${tradingDay()}.json`, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) return navigator.share({ files: [file] }).catch(() => {});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
  },
  import() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'application/json,.json';
    inp.onchange = async () => {
      try {
        const s = JSON.parse(await inp.files[0].text());
        if (!s.settings || !Array.isArray(s.trades)) throw new Error('fichier non reconnu');
        if (!confirm('Remplacer toutes les données actuelles ?')) return;
        S = s; save(); render();
      } catch (e) { alert('Import impossible : ' + e.message); }
    };
    inp.click();
  },
  reset() {
    if (prompt('Tape EFFACER pour tout supprimer.') !== 'EFFACER') return;
    localStorage.removeItem(KEY); S = load(); render();
  },
};

document.addEventListener('click', e => {
  const t = e.target.closest('[data-tab]');
  if (t && !gate) { tab = t.dataset.tab; render(); return; }
  const b = e.target.closest('[data-act]');
  if (b) ACTIONS[b.dataset.act]?.(b);
});

// Rafraîchit l'heure et le statut à chaque retour dans l'app et chaque minute.
document.addEventListener('visibilitychange', () => { if (!document.hidden && !gate) render(); });
setInterval(() => { if (!gate && tab === 'today') render(); }, 60e3);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
render();
