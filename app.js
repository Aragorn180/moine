'use strict';
// Moine — garde-fou de discipline du plan « Candle Daily ».
// Tout est stocké en local (localStorage) sur l'iPhone ; aucun serveur.

const KEY = 'moine.v1';
const DEFAULTS = { capital: 50000, riskA: 0.5, riskB: 0.25, cooldownMin: 30, maxTrades: 1, unlockMin: 10 };
// Actifs tradables. lot = $ par pip pour 1 lot (forex coté USD) ; sinon taille en $ par point.
const PAIRS = {
  DXY: { name: 'DXY', pip: 0.01, unit: 'pts', smt: 'l\'EURUSD' },
  EURUSD: { name: 'EU', pip: 0.0001, unit: 'pips', lot: 10, smt: 'le DXY' },
  GBPUSD: { name: 'GU', pip: 0.0001, unit: 'pips', lot: 10, smt: 'l\'EURUSD' },
  BTCUSDT: { name: 'BTC', pip: 1, unit: '$', smt: 'ETH', h24: true },
  NAS100: { name: 'NAS', pip: 1, unit: 'pts', smt: 'le S&P 500 (ES)' },
};
const ASSETS = Object.keys(PAIRS);
// Narrative obligatoire chaque semaine sur ces trois-là, sinon MT5 reste bloqué. GU et NAS : seulement pour les trader.
const REQUIRED = ['DXY', 'EURUSD', 'BTCUSDT'];

// Questions courtes, une par écran. mode stop : « oui » = pas de trade. must : « non » (ou contre le sens) = pas de trade.
// grade : compte pour le grade (tout bon = A, un ou deux ratés = B, plus = pas de trade).
// dir : choix dont chaque réponse a un sens ; elle doit aller dans le sens du trade.
const WEEKLY = [['OLHC', 'long'], ['OHLC', 'short']];
const BULLBEAR = [['Bullish', 'long'], ['Bearish', 'short']];
const COMMON = [
  { q: 'Sens DOL ?', mode: 'must', why: 'Contre la DOL' },
  { q: 'News rouge ?', mode: 'stop', why: 'News rouge' },
  { q: 'Biais tranché ?', mode: 'must', why: 'Biais pas tranché' },
  { q: 'Contre un CRT noté ?', mode: 'stop', why: 'Contre un CRT noté' },
  { q: 'Weekly ?', dir: WEEKLY, mode: 'grade' },
  { q: 'Dealing range 20 ?', dir: BULLBEAR, mode: 'grade' },
  { q: 'Dealing range 40 ?', dir: BULLBEAR, mode: 'grade' },
  { q: 'Dealing range 60 ?', dir: BULLBEAR, mode: 'grade' },
  { q: 'KL ?', mode: 'grade' },
  { q: 'SMT ?', mode: 'grade' },
];
const PLANS = {
  daily: { name: 'CRT Daily', q: [
    { q: 'Daily ?', dir: WEEKLY, mode: 'must', why: 'Daily contre le trade' },
    { q: 'CRT Daily valide ?', mode: 'must', why: 'CRT Daily pas valide' },
    { q: 'Purge horaire HP ?', mode: 'grade' },
    { q: 'Entrée après la purge ?', mode: 'must', why: 'Entrée anticipée' },
  ] },
  h4: { name: 'CRT H4', q: [
    { q: 'Daily ?', dir: WEEKLY, mode: 'must', why: 'Daily contre le trade' },
    { q: 'CRT H4 valide ?', mode: 'must', why: 'CRT H4 pas valide' },
    { q: 'Purge horaire 1h · 5h · 9h ?', mode: 'grade' },
    { q: 'Entrée M15 après la purge ?', mode: 'must', why: 'Entrée anticipée' },
  ] },
  ara: { name: 'Ara\'s Model 🧪', q: [
    { q: 'CRT Daily valide ?', mode: 'must', why: 'CRT Daily pas valide' },
    { q: 'TS 1 dans le bon quart Daily ?', mode: 'grade' },
    { q: 'TS 2 dans le bon quart H4 ?', mode: 'grade' },
    { q: 'Entrée H1 après les TS ?', mode: 'must', why: 'Entrée anticipée' },
  ] },
};
const FINAL = [
  { q: 'SL derrière la purge ?', mode: 'must', why: 'SL mal placé' },
  { q: 'TP1 · TP2 · BE écrits ?', mode: 'must', why: 'Sortie pas écrite' },
  { q: 'Trade de rattrapage ?', mode: 'stop', why: 'Trade de rattrapage' },
  { q: 'Calme ?', mode: 'must', why: 'État émotionnel' },
];
const UNLOCK = 'MOINE|'; // préfixe du jeton lu par le raccourci MetaTrader
const QUARTERS = [['Q1', 17], ['Q2', 21], ['Q3', 1], ['Q4', 5], ['Q5', 9], ['Q6', 13]];
const HP = new Set([1, 2, 3, 4]); // Q2..Q5 : ouvertures 21h, 1h, 5h, 9h NY
// Seules raisons de rouvrir MT5 une fois en position : les actions écrites dans le plan.
const MANAGE = ['TP1 touché : partiel 50 %', 'BE du runner (clôture au-delà du FVG)', 'Clôture du vendredi', 'SL ou TP2 touché : vérifier'];
const MANAGE_MIN = 5;
const BREAKS = ['SL déplacé', 'Sortie anticipée', 'Surtaille', 'Ré-entrée', 'Hors plan'];

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
const missingAssets = (k = weekKey()) => REQUIRED.filter(x => !assetDone(narrative(k)[x]));
const biasOf = pair => narrative()[pair]?.bias;

// MT5 est toujours bloqué : Moine ne l'ouvre que quelques minutes, après une fiche position
// validée ou pour une action de gestion prévue. Heure locale de l'iPhone, format relu par Raccourcis.
function unlockToken(until) {
  const x = new Date(until), p = n => String(n).padStart(2, '0');
  return `${UNLOCK}${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
}
function copyUnlock(minutes) {
  const until = Date.now() + minutes * 60e3;
  return navigator.clipboard.writeText(unlockToken(until)).then(() => until, () => null);
}
const pip = pair => PAIRS[pair].pip;
const unit = pair => PAIRS[pair].unit;
const pname = pair => PAIRS[pair]?.name || pair;
const openTrade = () => S.trades.find(t => t.r == null);

// Paires proposables : narrative faite, pas en Observation, marché ouvert.
const tradable = () => ASSETS.filter(p => assetDone(narrative()[p]) && biasOf(p) !== 'Observation'
  && (PAIRS[p].h24 || !forexClosed()));

// ---------- statut du jour ----------
const tradesOn = d => S.trades.filter(t => t.day === d);
function status() {
  const now = Date.now(), d = tradingDay(), miss = missingAssets();
  if (miss.length)
    return { ok: false, cls: 'no', title: 'MT5 bloqué.', detail: `Narrative de la semaine à faire : ${miss.map(pname).join(', ')}.`, go: 'week' };
  if (S.cooldownUntil > now)
    return { ok: false, cls: 'wait', title: 'Respire.', detail: `Plan refusé. Nouvel essai possible à ${hhmm(S.cooldownUntil)}.` };
  if (!tradable().length)
    return { ok: false, cls: 'no', title: 'Semaine d\'observation.', detail: 'Tu as décidé de regarder cette semaine. Tu regardes.' };
  if (tradesOn(d).length >= S.settings.maxTrades)
    return { ok: false, cls: 'no', title: 'Trade du jour pris.', detail: 'Rien d\'autre aujourd\'hui. Prochaine daily à 17h NY.' };
  const q = quarter();
  if (!HP.has(q))
    return { ok: false, cls: 'wait', title: 'Hors fenêtre.', detail: q === 5
      ? 'Après-midi NY : plus de setup. Prochaine ouverture HP à 21h NY.'
      : 'Q1 : on attend la purge à l\'ouverture de 21h NY.' };
  if (forexClosed(d))
    return { ok: true, cls: 'wait', title: 'Marchés fermés.', detail: 'BTC seulement.' };
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
    const st = status(), d = tradingDay(), n = ny(), nar = narrative();
    const todays = tradesOn(d);
    return `
      <h1>Moine</h1>
      <p class="sub">${frDay(d)} · ${String(n.h).padStart(2, '0')}:${String(n.min).padStart(2, '0')} NY</p>
      <div class="card">
        <div class="status"><span class="dot ${st.cls}"></span><span class="big">${st.title}</span></div>
        <p class="dim" style="margin:8px 0 0">${st.detail}</p>
        ${quartersStrip()}
      </div>
      ${openTrade() ? '<button class="primary" data-tab="position">Voir ma position</button>'
        : st.ok ? '<button class="primary" data-tab="position">Préparer une position</button>'
        : st.go ? `<button class="primary" data-tab="${st.go}">Écrire la narrative</button>` : ''}
      <h2>Semaine</h2><div class="card">${ASSETS.map(x => `
        <div class="row"><span class="dim">${pname(x)}</span>${assetDone(nar[x]) ? `<b>${esc(nar[x].bias)}</b>`
          : REQUIRED.includes(x) ? '<span class="tag r">À faire</span>' : '<span class="dim small">—</span>'}</div>`).join('')}</div>
      ${todays.length ? `<h2>Aujourd'hui</h2>${todays.map(tradeCard).join('')}` : ''}
      <h2>Règles</h2>
      <div class="card small dim">
        Paire → plan → questions → fiche position.<br>
        Confluences : Weekly, DR 20 · 40 · 60, KL, SMT, purge horaire.<br>
        Jamais d'ordre posé avant la purge. RR ≥ 2.<br>
        A = toutes → ${S.settings.riskA} % · B = une ou deux manquantes → ${S.settings.riskB} % · sinon rien.
      </div>`;
  },

  position() {
    const t = openTrade();
    if (t) return `
      <h1>Position</h1>
      <p class="sub">MT5 reste bloqué. Il ne s'ouvre que pour une action prévue par le plan.</p>
      ${tradeCard(t)}
      <h2>Ouvrir MT5 ${MANAGE_MIN} min pour</h2>
      <div class="stack">${MANAGE.map(m => `<button data-act="manage" data-v="${esc(m)}">${esc(m)}</button>`).join('')}</div>
      ${t.mgmt?.length ? `<h2>Gestion faite</h2><div class="card">${t.mgmt.map(m =>
        `<div class="row small"><span class="dim">${hhmm(m.ts)}</span><span>${esc(m.why)}</span></div>`).join('')}</div>` : ''}`;
    const st = status();
    return `
      <h1>Position</h1>
      <p class="sub">Tu notes ton trade ici avant tout. MT5 s'ouvre ${S.settings.unlockMin} min pour placer exactement ce ticket.</p>
      <div class="card">
        <div class="status"><span class="dot ${st.cls}"></span><span class="big">${st.title}</span></div>
        <p class="dim" style="margin:8px 0 0">${st.detail}</p>
      </div>
      ${st.ok ? '<button class="primary" data-act="gate">Préparer une position</button>'
        : st.go ? `<button class="primary" data-tab="${st.go}">Écrire la narrative</button>` : ''}`;
  },

  week() {
    const k = weekKey(), nar = narrative(k);
    // Un actif fait est figé une fois la semaine lancée ; on peut toujours compléter ceux qui manquent.
    const frozen = x => assetDone(nar[x]) && !forexClosed();
    const ph = { DXY: ['old high W 99.80', 'FVG D 98.95'], EURUSD: ['old low W 1.1520', 'OB D 1.1610'], GBPUSD: ['old high W 1.3450', 'OB D 1.3320'], BTCUSDT: ['old high W 112 000', 'FVG D 106 500'], NAS100: ['old high W 25 400', 'FVG D 24 800'] };
    const label = x => `${pname(x)}${REQUIRED.includes(x) ? '' : ' · optionnel'}`;
    const past = Object.keys(S.weeks).filter(x => x !== k).sort().reverse().slice(0, 8);
    return `
      <h1>Semaine</h1>
      <p class="sub">Semaine du ${frDay(k)} · Y → 6M → 3M → M → W. Pas aligné → Observation.</p>
      ${ASSETS.map(x => frozen(x) ? `<h2>${label(x)}</h2><div class="card">
          <div class="row"><span class="dim">Biais</span><b>${esc(nar[x].bias)}</b></div>
          ${nar[x].bias !== 'Observation' ? `<div class="row"><span class="dim">DOL</span><b>${esc(nar[x].dol)}</b></div>
          <div class="row"><span class="dim">Key level</span><b>${esc(nar[x].key)}</b></div>` : ''}</div>`
      : `<h2>${label(x)}</h2><div class="card" data-asset="${x}">
          <div class="choices three">${['Long', 'Short', 'Observation'].map(b =>
            `<button data-act="bias" data-v="${b}" class="${nar[x]?.bias === b ? 'on' : ''}">${b}</button>`).join('')}</div>
          <label>Draw on liquidity</label><input class="dol" value="${esc(nar[x]?.dol)}" placeholder="ex. ${ph[x][0]}">
          <label>Key level HTF</label><input class="key" value="${esc(nar[x]?.key)}" placeholder="ex. ${ph[x][1]}">
        </div>`).join('')}
      ${ASSETS.some(x => !frozen(x)) ? `<label>Notes</label><textarea id="notes">${esc(S.weeks[k]?.notes)}</textarea>
        <div style="margin-top:16px"><button class="primary" data-act="saveWeek">Enregistrer</button></div>`
      : '<p class="dim small" style="margin-top:12px">Narrative figée jusqu\'au week-end.</p>'}
      ${past.length ? `<h2>Semaines passées</h2><div class="card">${past.map(p =>
        `<div class="row"><span class="dim">${p}</span><b>${ASSETS.map(x => `${pname(x)} ${esc(narrative(p)[x]?.bias?.[0] || '·')}`).join(' · ')}</b></div>`).join('')}</div>` : ''}`;
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
        ${field('unlockMin', 'MT5 ouvert après une fiche validée (min)', '1')}
        <div style="margin-top:16px"><button class="primary" data-act="saveSettings">Programmer pour demain</button></div>
      </div>
      <h2>Bloquer MetaTrader</h2>
      <div class="card small">
        <p>MT5 est toujours bloqué. Moine copie un jeton de quelques minutes quand une fiche position est validée (narratives faites, questionnaire passé) ou pour une action de gestion prévue. Le raccourci le lit.</p>
        <p>Raccourcis → Automatisation → <b>+</b> → <b>App</b> → MetaTrader 5 → <b>Est ouverte</b> → <b>Exécuter immédiatement</b> → Nouveau raccourci vide. Actions dans l'ordre :</p>
        <ol style="padding-left:20px;margin:0 0 12px">
          <li><b>Obtenir le presse-papiers</b></li>
          <li><b>Si</b> Presse-papiers <b>commence par</b> <code>MOINE|</code> :<br><b>Enregistrer le fichier</b> Presse-papiers → dossier Raccourcis, « Demander où » désactivé, sous-chemin <code>moine.txt</code>, « Remplacer » activé. <b>Fin si</b>.</li>
          <li><b>Obtenir le fichier du dossier</b> Raccourcis, <code>moine.txt</code>, « Erreur si introuvable » désactivé.</li>
          <li><b>Remplacer le texte</b> <code>MOINE|</code> par rien dans Fichier.</li>
          <li><b>Obtenir les dates de l'entrée</b> Texte remplacé.</li>
          <li><b>Si</b> Dates <b>est après</b> Date actuelle : rien. <b>Sinon</b> : <b>Afficher la notification</b> « MT5 bloqué : passe par Moine », puis <b>Aller à l'écran d'accueil</b>. <b>Fin si</b>.</li>
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
    <div class="row"><b>${pname(t.pair)} ${t.dir === 'long' ? '↑ Long' : '↓ Short'}</b><span class="tag">${t.plan ? esc(PLANS[t.plan].name) + ' · ' : ''}${t.grade} · ${t.risk} %</span></div>
    ${t.entry != null ? `<div class="row"><span class="dim">Entrée</span><b>${t.entry}</b></div>
    <div class="row"><span class="dim">SL</span><b>${t.sl} (${t.stop} ${unit(t.pair)})</b></div>
    <div class="row"><span class="dim">TP1 / TP2</span><b>${t.tp1} / ${t.tp2}</b></div>
    <div class="row"><span class="dim">${t.day}</span><b>${t.size} · RR ${(t.tp / t.stop).toFixed(2)}</b></div>`
    : `<div class="row"><span class="dim">${t.day}</span><span class="dim">SL ${t.stop} · TP ${t.tp} · ${t.size}</span></div>`}
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
  const a = gate?.a || {}, plan = PLANS[a.plan];
  const ask = prefix => (x, i) => ({ kind: x.dir ? 'dir' : 'yn', ...x, key: prefix + i });
  return [
    { kind: 'pick', q: 'Paire ?', key: 'pair', opts: tradable(), all: ASSETS },
    { kind: 'pick', q: 'Plan ?', key: 'plan', opts: Object.keys(PLANS), all: Object.keys(PLANS) },
    ...COMMON.map(ask('c')),
    ...(plan ? plan.q.map(ask('p')) : []),
    { kind: 'grade' },
    { kind: 'sheet' },
    ...FINAL.map(ask('f')),
    { kind: 'oath' },
    { kind: 'ticket' },
  ];
}

function startGate() { gate = { i: 0, a: { g: {} } }; render(); }

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
  const keys = gateSteps().filter(x => x.mode === 'grade').map(x => x.key);
  const miss = keys.filter(k => !a.g[k]).length;
  return miss === 0 ? 'A' : miss <= 2 ? 'B' : null;
}

function sizing(a) {
  const risk = a.grade === 'A' ? S.settings.riskA : S.settings.riskB;
  const usd = S.settings.capital * risk / 100;
  // Forex coté USD : 10 $ par pip pour 1 lot. BTC : stop en $, taille en BTC. Indices : $ par point.
  const P = PAIRS[a.pair];
  const size = P.lot ? `${(Math.floor(usd / (a.stop * P.lot) * 100) / 100).toFixed(2)} lot`
    : a.pair === 'BTCUSDT' ? `${(usd / a.stop).toFixed(4)} BTC`
    : `${(usd / a.stop).toFixed(2)} $/${P.unit === 'pts' ? 'pt' : P.unit}`;
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
    <h1>MT5 ouvert.</h1><p class="sub">${gate.until ? `Jusqu'à ${hhmm(gate.until)}. Place exactement le ticket, SL et TP compris, puis laisse le plan travailler.`
      : 'Copie du jeton impossible : retourne dans Position et réessaie.'}</p>
    <button class="primary" data-act="closeGate">OK</button>`;

  const steps = gateSteps(), st = steps[gate.i], a = gate.a;
  const head = `<div class="progress"><i style="width:${100 * gate.i / (steps.length - 1)}%"></i></div>`;
  const quit = '<button style="margin-top:24px" data-act="abandon">Je n\'entre pas</button>';

  if (st.kind === 'yn') return `${head}<p class="q">${st.q}</p>
    <div class="pair"><button data-act="answer" data-v="1">Oui</button><button data-act="answer" data-v="0">Non</button></div>${quit}`;
  if (st.kind === 'dir') return `${head}<p class="q">${st.q}</p>
    <div class="pair">${st.dir.map(([l, d]) => `<button data-act="answer" data-v="${d === a.dir ? 1 : 0}">${l}</button>`).join('')}</div>${quit}`;
  if (st.kind === 'pick') {
    const label = o => st.key === 'pair' ? pname(o) : PLANS[o].name;
    const why = o => !assetDone(narrative()[o]) ? 'narrative à faire' : biasOf(o) === 'Observation' ? 'observation' : 'marché fermé';
    return `${head}<p class="q">${st.q}</p>
    <div class="choices">${st.all.map(o => st.opts.includes(o)
      ? `<button data-act="pick" data-v="${o}">${label(o)}</button>`
      : `<button disabled>${label(o)} <span class="small">· ${why(o)}</span></button>`).join('')}</div>${quit}`;
  }
  if (st.kind === 'grade') {
    const g = grade(a);
    if (!g) { setTimeout(() => fail('Grade C : plus de deux confluences manquantes'), 0); return ''; }
    a.grade = g;
    return `${head}<p class="dim">Grade</p><div class="grade">${g}</div>
      <p class="sub" style="margin-top:12px">Risque ${g === 'A' ? S.settings.riskA : S.settings.riskB} % du capital.</p>
      <button class="primary" data-act="next">Continuer</button>${quit}`;
  }
  if (st.kind === 'sheet') {
    const f = (id, label) => `<label>${label}</label><input id="${id}" type="number" inputmode="decimal" step="any">`;
    return `${head}<p class="q">Fiche position ${pname(a.pair)} ${a.dir === 'long' ? '↑ long' : '↓ short'} · ${PLANS[a.plan].name}.</p>
      ${f('p_entry', 'Entrée (prix)')}${f('p_sl', 'Stop loss (prix)')}
      ${f('p_tp1', 'TP1 — 50 % du CRT (prix)')}${f('p_tp2', 'TP2 — extrême opposé (prix)')}
      ${f('p_spread', `Spread actuel (${unit(a.pair)})`)}
      <div style="margin-top:20px"><button class="primary" data-act="sheet">Vérifier</button></div>${quit}`;
  }
  if (st.kind === 'oath') return `${head}<p class="q">Écris : « je respecte mon stop »</p>
    <input id="oath" autocomplete="off" autocapitalize="off">
    <div style="margin-top:20px"><button class="primary" data-act="oath">Valider</button></div>${quit}`;
  if (st.kind === 'ticket') {
    const z = sizing(a);
    return `<h1>Ticket</h1><p class="sub">Exactement ça. Rien de plus.</p>
      <div class="card ticket">
        <div class="row"><span class="dim">Paire</span><b>${pname(a.pair)} · ${PLANS[a.plan].name}</b></div>
        <div class="row"><span class="dim">Sens</span><b>${a.dir === 'long' ? '↑ Long' : '↓ Short'}</b></div>
        <div class="row"><span class="dim">Grade</span><b>${a.grade} · ${z.risk} %</b></div>
        <div class="row"><span class="dim">Risque</span><b>${z.usd.toFixed(0)} $</b></div>
        <div class="row"><span class="dim">Taille</span><b>${z.size}</b></div>
        <div class="row"><span class="dim">Entrée</span><b>${a.entry}</b></div>
        <div class="row"><span class="dim">SL</span><b>${a.sl} (${a.stop} ${unit(a.pair)})</b></div>
        <div class="row"><span class="dim">TP1 (moitié)</span><b>${a.tp1}</b></div>
        <div class="row"><span class="dim">TP2</span><b>${a.tp2}</b></div>
        <div class="row"><span class="dim">RR</span><b>${(a.tp / a.stop).toFixed(2)}</b></div>
      </div>
      <div class="stack"><button class="primary" data-act="enter">Ouvrir MT5 ${S.settings.unlockMin} min</button>
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
  // v = 1 : « oui », ou réponse dans le sens du trade.
  answer(b) {
    const st = gateSteps()[gate.i], yes = b.dataset.v === '1';
    if (st.mode === 'stop' ? yes : st.mode === 'must' && !yes) return fail(st.why);
    if (st.mode === 'grade') gate.a.g[st.key] = yes;
    next();
  },
  pick(b) {
    const st = gateSteps()[gate.i], v = b.dataset.v;
    gate.a[st.key] = v;
    if (st.key === 'pair') gate.a.dir = biasOf(v) === 'Short' ? 'short' : 'long';
    next();
  },
  sheet() {
    const a = gate.a, v = id => $('#' + id).value.replace(',', '.');
    const [entry, sl, tp1, tp2, spread] = ['p_entry', 'p_sl', 'p_tp1', 'p_tp2', 'p_spread'].map(id => parseFloat(v(id)));
    if ([entry, sl, tp1, tp2, spread].some(isNaN) || spread < 0) return alert('Remplis les cinq champs.');
    const up = a.dir === 'long' ? 1 : -1;
    // Erreurs de saisie (mauvais côté) : on corrige, pas de pénalité.
    if ((entry - sl) * up <= 0) return alert(`En ${a.dir}, le SL doit être ${up > 0 ? 'sous' : 'au-dessus de'} l'entrée.`);
    if ((tp1 - entry) * up <= 0 || (tp2 - tp1) * up <= 0) return alert('Ordre attendu : entrée, puis TP1, puis TP2 dans le sens du trade.');
    const stop = +(Math.abs(entry - sl) / pip(a.pair)).toFixed(1), tp = +(Math.abs(tp2 - entry) / pip(a.pair)).toFixed(1);
    if (tp / stop < 2) return fail(`RR ${(tp / stop).toFixed(2)} < 2`);
    if (spread >= 0.15 * stop) return fail(`Spread ${spread} ≥ 15 % du stop (${stop} ${unit(a.pair)})`);
    // Prix gardés tels que saisis pour l'affichage (1.1600 reste 1.1600).
    Object.assign(a, { entry: v('p_entry'), sl: v('p_sl'), tp1: v('p_tp1'), tp2: v('p_tp2'), spread, stop, tp });
    next();
  },
  oath() {
    const v = $('#oath').value.trim().toLowerCase().replace(/[«»"]/g, '').trim();
    if (v !== 'je respecte mon stop') return alert('Écris la phrase exactement.');
    next();
  },
  enter() {
    const a = gate.a, z = sizing(a);
    S.trades.push({ id: Date.now().toString(36), ts: Date.now(), day: tradingDay(), pair: a.pair, plan: a.plan, dir: a.dir,
      grade: a.grade, risk: z.risk, entry: a.entry, sl: a.sl, tp1: a.tp1, tp2: a.tp2, stop: a.stop, tp: a.tp,
      size: z.size, r: null, broke: [], mgmt: [] });
    save();
    copyUnlock(S.settings.unlockMin).then(until => { gate = { done: 'in', until }; render(); });
  },
  manage(b) {
    const t = openTrade(), why = b.dataset.v;
    copyUnlock(MANAGE_MIN).then(until => {
      if (!until) return alert('Copie impossible : réessaie.');
      t.mgmt = [...(t.mgmt || []), { ts: Date.now(), why }];
      save(); render();
      alert(`MT5 ouvert jusqu'à ${hhmm(until)} pour : ${why}. Rien d'autre.`);
    });
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
  saveWeek() {
    const k = weekKey(), assets = { ...narrative(k) };
    // On enregistre ce qui est rempli ; un actif incomplet reste « à faire » et garde MT5 bloqué.
    for (const card of document.querySelectorAll('[data-asset]')) {
      const x = card.dataset.asset, bias = card.querySelector('button.on')?.dataset.v;
      const dol = card.querySelector('.dol').value.trim(), key = card.querySelector('.key').value.trim();
      if (bias || dol || key) assets[x] = { bias, dol, key };
    }
    const dx = assets.DXY?.bias;
    for (const x of ['EURUSD', 'GBPUSD']) {
      const b = assets[x]?.bias;
      if (dx && b && dx !== 'Observation' && dx === b)
        return alert(`DXY ${dx} et ${pname(x)} ${b} : incohérent. Le DXY et ${pname(x)} vont en sens inverse.`);
    }
    S.weeks[k] = { ...S.weeks[k], assets, notes: $('#notes').value.trim(), ts: Date.now() };
    save();
    const miss = missingAssets(k);
    if (miss.length) { alert(`Enregistré. Reste à faire : ${miss.map(pname).join(', ')} (biais, DOL et key level).`); return render(); }
    tab = 'today'; render();
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
setInterval(() => { if (!gate && (tab === 'today' || tab === 'position')) render(); }, 60e3);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
render();
