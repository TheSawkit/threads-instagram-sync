// ==UserScript==
// @name         Threads – Follow All Instagram Following
// @namespace    https://github.com/TheSawkit/threads-instagram-sync
// @version      1.0.0
// @description  Auto-follow on Threads everyone you follow on Instagram.
// @author       SAWKIT
// @license      MIT
// @homepageURL  https://github.com/TheSawkit/threads-instagram-sync
// @supportURL   https://github.com/TheSawkit/threads-instagram-sync/issues
// @match        https://www.instagram.com/*
// @match        https://instagram.com/*
// @match        https://www.threads.com/*
// @match        https://threads.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    DELAY: {
      FOLLOW_BASE_MS: 1500,
      JITTER_PERCENT: 0.35,
      FAST_MS: 150,
      MICRO_PAUSE_PROBABILITY: 0.06,
      MICRO_PAUSE_MIN_MS: 3000,
      MICRO_PAUSE_MAX_MS: 7000,
    },
    BREATHER: {
      MIN_FOLLOWS: 25,
      MAX_FOLLOWS: 45,
      MIN_MS: 8000,
      MAX_MS: 18000,
    },
    RATES: {
      MAX_PER_SESSION: 3000,
      IG_PAGE_SIZE: 200,
      MAX_CONSECUTIVE_ERRORS: 5,
    },
    API: {
      IG_APP_ID: '936619743392459',
      TH_APP_ID: '238260118697367',
      TH_DOC_ID_FALLBACK: '26234294899535416',
      TH_FRIENDLY_NAME: 'useTHFollowMutationFollowMutation',
    },
    KEYS: {
      HASH: '_tmigpks_',
    }
  };

  const FOLLOW_RESULT = {
    FOLLOWED: 'followed',
    ALREADY: 'already',
    PENDING: 'pending',
    ERROR: 'error',
  };

  const STATE_THEMES = {
    [FOLLOW_RESULT.FOLLOWED]: { icon: '➕', color: '#66ff66' },
    [FOLLOW_RESULT.ALREADY]: { icon: '🔄', color: '#888888' },
    [FOLLOW_RESULT.PENDING]: { icon: '🕐', color: '#88aaff' },
    [FOLLOW_RESULT.ERROR]: { icon: '⚠️', color: '#ffaa00' },
  };

  const ENV = {
    IS_INSTAGRAM: location.hostname.includes('instagram.com'),
    IS_THREADS: location.hostname.includes('threads.com'),
    RAW_HASH: location.hash,
  };

  const sleep = ms => new Promise(res => setTimeout(res, ms));
  const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const randomBool = prob => Math.random() < prob;

  const Tokens = {
    getCsrf: () => decodeURIComponent(document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1] || ''),
    getIgUserId: () => document.cookie.match(/(?:^|;\s*)ds_user_id=(\d+)/)?.[1] || null,

    getPageMatch: (regex, fallback = '') => document.documentElement.innerHTML.match(regex)?.[1] || fallback,

    getLsd: () =>
      document.querySelector('meta[name="lsd"]')?.content ||
      Tokens.getPageMatch(/"LSD"\s*,\s*\[\]\s*,\s*\{"token"\s*:\s*"([^"]+)"\}/) ||
      Tokens.getPageMatch(/"l"\s*:\s*"([a-zA-Z0-9_-]{10,})"/),

    getAsbd: () => Tokens.getPageMatch(/"ASBD_ID"\s*,\s*\[\]\s*,\s*\{"id"\s*:\s*"(\d+)"/, '359341'),
    getBloks: () => Tokens.getPageMatch(/"bloks_version"\s*:\s*"([a-f0-9]+)"/, Tokens.getPageMatch(/"BLOKS_VERSION_ID"\s*,\s*\[\]\s*,\s*\{"versionId"\s*:\s*"([^"]+)"/)),
    getWebSession: () => Tokens.getPageMatch(/"WebSessionId"\s*:\s*"([^"]+)"/),
    getFbDtsg: () => Tokens.getPageMatch(/"DTSGInitialData"\s*,\s*\[\]\s*,\s*\{"token"\s*:\s*"([^"]+)"\}/),

    uuid: () => typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    })
  };

  const CrossDomainSync = {
    encode: arr => btoa(unescape(encodeURIComponent(JSON.stringify(arr)))),
    decode: hash => {
      const match = hash.match(new RegExp(`${CONFIG.KEYS.HASH}=([A-Za-z0-9+/=]+)`));
      if (!match) return null;
      try {
        const parsed = JSON.parse(decodeURIComponent(escape(atob(match[1]))));
        return Array.isArray(parsed) ? parsed : null;
      } catch { return null; }
    },
    cleanHash: () => {
      const clean = location.hash.replace(new RegExp(`#?${CONFIG.KEYS.HASH}[^&]*`), '').replace(/^#$/, '');
      history.replaceState(null, '', location.pathname + location.search + clean);
    }
  };

  class RhythmController {
    constructor() {
      this.followsCount = 0;
      this.nextBreather = randomInt(CONFIG.BREATHER.MIN_FOLLOWS, CONFIG.BREATHER.MAX_FOLLOWS);
    }

    async applyDelay(lastResult) {
      if (lastResult === FOLLOW_RESULT.ALREADY || lastResult === FOLLOW_RESULT.PENDING) {
        await sleep(CONFIG.DELAY.FAST_MS);
        return;
      }

      this.followsCount++;
      if (this.followsCount >= this.nextBreather) {
        this.followsCount = 0;
        this.nextBreather = randomInt(CONFIG.BREATHER.MIN_FOLLOWS, CONFIG.BREATHER.MAX_FOLLOWS);
        const duration = randomInt(CONFIG.BREATHER.MIN_MS, CONFIG.BREATHER.MAX_MS);
        UI.setStatus(`Pause [${Math.round(duration / 1000)}s] retaining session rhythm...`, '#888888');
        await sleep(duration);
        return;
      }

      if (randomBool(CONFIG.DELAY.MICRO_PAUSE_PROBABILITY)) {
        await sleep(randomInt(CONFIG.DELAY.MICRO_PAUSE_MIN_MS, CONFIG.DELAY.MICRO_PAUSE_MAX_MS));
        return;
      }

      const jitter = CONFIG.DELAY.FOLLOW_BASE_MS * CONFIG.DELAY.JITTER_PERCENT;
      await sleep(CONFIG.DELAY.FOLLOW_BASE_MS + randomInt(-jitter, jitter));
    }
  }

  const InstagramAPI = {
    async fetchFollowingPage(userId, cursor) {
      let url = `https://www.instagram.com/api/v1/friendships/${userId}/following/?count=${CONFIG.RATES.IG_PAGE_SIZE}`;
      if (cursor) url += `&max_id=${encodeURIComponent(cursor)}`;

      const res = await fetch(url, {
        credentials: 'include',
        headers: {
          'X-CSRFToken': Tokens.getCsrf(),
          'X-IG-App-ID': CONFIG.API.IG_APP_ID,
          'X-Instagram-AJAX': '1',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': '*/*',
          'Referer': 'https://www.instagram.com/',
        },
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },

    async collectAll(totalToScan, onProgress) {
      const userId = Tokens.getIgUserId();
      if (!userId) throw new Error('Unauthenticated (No ds_user_id)');

      const allPks = [];
      let cursor = null;
      let page = 0;
      let errorStreak = 0;

      while (allPks.length < CONFIG.RATES.MAX_PER_SESSION && !window._tmStop) {
        try {
          const data = await this.fetchFollowingPage(userId, cursor);
          errorStreak = 0;
          const users = data?.users || [];
          if (!users.length && page === 0) throw new Error('Data set empty');

          for (const u of users) {
            allPks.push({ pk: String(u.pk), username: u.username });
            await onProgress(allPks.length, totalToScan, u.username);
          }
          page++;

          if (!data?.next_max_id) break;
          cursor = data.next_max_id;
          await sleep(500);
        } catch (err) {
          errorStreak++;
          if (errorStreak >= 3) throw err;
          UI.setStatus(`Erreur page ${page + 1}: ${err.message}. Essai dans 3s...`, '#ffaa00');
          await sleep(3000);
        }
      }
      return allPks;
    }
  };

  const ThreadsAPI = {
    _docIdCache: null,

    async getMutationDocId() {
      if (this._docIdCache) return this._docIdCache;

      const docMatch = text =>
        text.match(/useTHFollowMutation[^}]*?doc_id"\s*:\s*"(\d+)"/)?.[1] ||
        text.match(/name:\s*"useTHFollowMutation"[^}]*?id:\s*"(\d+)"/)?.[1] ||
        text.match(/"useTHFollowMutation[^"]*"[^}]*?"(\d{10,})"/)?.[1] ||
        text.match(/FollowMutation[^}]*?doc(?:ument)?_?id["\s:]*"(\d+)"/i)?.[1];

      for (const script of document.querySelectorAll('script[type="application/json"], script:not([src])')) {
        const id = docMatch(script.textContent || '');
        if (id) return (this._docIdCache = id);
      }

      const idFromHtml = docMatch(document.documentElement.innerHTML);
      if (idFromHtml) return (this._docIdCache = idFromHtml);

      for (const script of [...document.querySelectorAll('script[src*="threads"]')].slice(0, 10)) {
        try {
          const text = await fetch(script.src, { credentials: 'include' }).then(r => r.text());
          const id = docMatch(text);
          if (id) return (this._docIdCache = id);
        } catch { continue; }
      }

      return CONFIG.API.TH_DOC_ID_FALLBACK;
    },

    getBaseHeaders() {
      const headers = {
        'X-CSRFToken': Tokens.getCsrf(),
        'X-IG-App-ID': CONFIG.API.TH_APP_ID,
        'X-FB-LSD': Tokens.getLsd(),
        'X-ASBD-ID': Tokens.getAsbd(),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.threads.com/',
        'Origin': 'https://www.threads.com',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        'Accept': '*/*',
      };

      const bloks = Tokens.getBloks();
      const webSession = Tokens.getWebSession();
      if (bloks) headers['X-BLOKS-VERSION-ID'] = bloks;
      if (webSession) headers['X-Web-Session-ID'] = webSession;

      return headers;
    },

    async checkStatus(userId) {
      try {
        const res = await fetch(`https://www.threads.com/api/v1/friendships/show/${userId}/`, {
          headers: this.getBaseHeaders()
        });
        const body = await res.json();
        if (body?.following) return FOLLOW_RESULT.ALREADY;
        if (body?.outgoing_request) return FOLLOW_RESULT.PENDING;
        return null;
      } catch { return null; }
    },

    async mutateGraphql(userId, docId) {
      const params = new URLSearchParams();
      params.set('lsd', Tokens.getLsd());
      params.set('fb_dtsg', Tokens.getFbDtsg() || '');
      params.set('__user', '0');
      params.set('__a', '1');
      params.set('__req', '1');
      params.set('fb_api_caller_class', 'RelayModern');
      params.set('fb_api_req_friendly_name', CONFIG.API.TH_FRIENDLY_NAME);
      params.set('doc_id', docId);
      params.set('variables', JSON.stringify({
        target_user_id: String(userId),
        media_id_attribution: null,
        container_module: 'ig_text_feed_profile',
        ranking_info_token: null,
        barcelona_source_quote_post_id: null,
        barcelona_source_reply_id: null
      }));

      const headers = this.getBaseHeaders();
      headers['X-FB-Friendly-Name'] = CONFIG.API.TH_FRIENDLY_NAME;

      const res = await fetch('https://www.threads.com/api/graphql', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: params.toString()
      });

      const body = await res.json().catch(() => ({}));
      const data = body?.data?.data?.user || body?.data?.user || body?.data?.xdt_follow_user || body?.data?.result || body?.data || {};
      const status = data?.friendship_status || {};

      if (status.following) return FOLLOW_RESULT.FOLLOWED;
      if (status.outgoing_request) return FOLLOW_RESULT.PENDING;
      if (res.ok && !body?.errors?.length && body?.status?.toLowerCase() === 'ok') return FOLLOW_RESULT.FOLLOWED;

      return null;
    },

    async mutateRestFallback(userId) {
      const payload = JSON.stringify({ user_id: userId, _uuid: Tokens.uuid() });
      const res = await fetch(`https://www.threads.com/api/v1/friendships/create/${userId}/`, {
        method: 'POST',
        credentials: 'include',
        headers: this.getBaseHeaders(),
        body: `signed_body=SIGNATURE.${encodeURIComponent(payload)}`,
      });

      const body = await res.json().catch(() => ({}));
      const status = body?.friendship_status || {};
      const msg = [body?.message, body?.feedback_message].join(' ').toLowerCase();

      if (status.following) return msg.includes('already') ? FOLLOW_RESULT.ALREADY : FOLLOW_RESULT.FOLLOWED;
      if (status.outgoing_request) return FOLLOW_RESULT.PENDING;
      if (res.status === 404 || msg.includes('not found') || msg.includes('no user')) return FOLLOW_RESULT.ERROR;
      if (res.ok && body?.status?.toLowerCase() === 'ok') return FOLLOW_RESULT.FOLLOWED;

      return FOLLOW_RESULT.ERROR;
    },

    async processFollow(userId) {
      const existingStatus = await this.checkStatus(userId);
      if (existingStatus) return existingStatus;

      const docId = await this.getMutationDocId();
      if (docId) {
        const graphqlRes = await this.mutateGraphql(userId, docId);
        if (graphqlRes) return graphqlRes;
      }
      return this.mutateRestFallback(userId);
    }
  };

  const Engine = {
    async runFollowCycle(pks, onProgress) {
      const stats = { done: 0, already: 0, pending: 0, failed: 0, total: pks.length };
      let errorStreak = 0;
      const rhythm = new RhythmController();

      for (const { pk, username } of pks) {
        if (window._tmStop) break;

        let result = FOLLOW_RESULT.ERROR;
        try {
          result = await ThreadsAPI.processFollow(pk);
        } catch { }

        if (result === FOLLOW_RESULT.ERROR) {
          errorStreak++;
          if (errorStreak >= CONFIG.RATES.MAX_CONSECUTIVE_ERRORS) {
            const delay = 30000 + randomInt(0, 15000);
            stats.failed++;
            onProgress(result, stats, username);
            let remaining = Math.round(delay / 1000);
            while (remaining > 0 && !window._tmStop) {
              UI.setStatus(`Pause anti-spam en cours (${remaining}s)...`, '#ffaa00');
              await sleep(1000);
              remaining--;
            }
            errorStreak = 0;
            continue;
          }
        } else {
          errorStreak = 0;
        }

        if (result === FOLLOW_RESULT.FOLLOWED) stats.done++;
        else if (result === FOLLOW_RESULT.ALREADY) stats.already++;
        else if (result === FOLLOW_RESULT.PENDING) stats.pending++;
        else stats.failed++;

        onProgress(result, stats, username);
        await rhythm.applyDelay(result);
      }
      return stats;
    }
  };

  const UI = {
    panel: null,

    init(phase) {
      if (document.getElementById('tm-root')) return;

      const isSrc = phase === 1;
      const color = isSrc ? '#E1306C' : '#FFFFFF';
      const bg = isSrc ? 'rgba(225,48,108,0.1)' : 'rgba(255,255,255,0.08)';
      const label = isSrc ? 'Étape 1 sur 2' : 'Étape 2 sur 2';
      const title = isSrc ? '📸 Importer depuis Instagram' : '@ S\'abonner sur Threads';
      const btnTxt = isSrc ? '▶️ Lancer l\'importation' : '▶️ Démarrer les abonnements';

      this.panel = document.createElement('div');
      this.panel.id = 'tm-root';
      this.panel.innerHTML = `
        <style>
          #tm-root {
            position: fixed; bottom: 32px; right: 32px; z-index: 2147483647;
            background: #101010 !important; backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
            color: #FAFAFA; border-radius: 20px; padding: 24px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            font-size: 14px; width: 330px; box-shadow: 0 10px 40px rgba(0,0,0,0.6); user-select: none;
          }
          /* Bordure arc-en-ciel élégante Instagram/Threads */
          #tm-root::after {
            content: ""; position: absolute; inset: 0; border-radius: 20px;
            pointer-events: none; padding: 2px;
            background: linear-gradient(45deg, #fdf497 0%, #fd5949 20%, #d6249f 40%, #285AEB 80%);
            -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
            -webkit-mask-composite: xor; mask-composite: exclude;
          }
          #tm-root header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
          #tm-root .badge { background: ${bg}; color: ${color}; font-size: 11px; font-weight: 600; padding: 5px 10px; border-radius: 8px; text-transform: uppercase; letter-spacing: 0.3px; }
          #tm-root nav button { background: transparent; border: none; font-size: 18px; color: #777; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; transition: color 0.2s; border-radius: 50%; }
          #tm-root nav button:hover { color: #FFF; background: rgba(255,255,255,0.08); }
          #tm-root h3 { margin: 0 0 20px; font-size: 17px; font-weight: 700; letter-spacing: -0.4px; color: #FAFAFA !important; }
          #tm-root .tm-btn { border: none; border-radius: 12px; padding: 13px; font-size: 15px; font-weight: 600; cursor: pointer; width: 100%; transition: all 0.2s; display: flex; justify-content: center; align-items: center; gap: 8px; }
          #tm-btn-primary { background: #FAFAFA; color: #000; }
          #tm-btn-primary:active { transform: scale(0.96); }
          #tm-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
          #tm-root #tm-btn-abort { background: rgba(255,255,255,0.1); color: #FAFAFA; display: none; margin-top: 8px; }
          #tm-root #tm-btn-abort:hover { background: rgba(255,255,255,0.15); }
          #tm-monitor { margin-top: 16px; min-height: 40px; }
          #tm-console { margin: 0; font-size: 13px; color: #A0A0A0; line-height: 1.5; font-weight: 400; }
          #tm-console strong { color: #FAFAFA; font-weight: 600; }
          .tm-track { height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; margin-top: 14px; overflow: hidden; }
          .tm-fill { height: 100%; background: linear-gradient(90deg, #fdf497 0%, #fd5949 20%, #d6249f 40%, #285AEB 80%); width: 0; transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1); border-radius: 2px; }
        </style>
        <header><div class="badge">${label}</div><nav><button id="tm-close">✕</button></nav></header>
        <h3>${title}</h3>
        <button class="tm-btn" id="tm-btn-primary">${btnTxt}</button>
        <button class="tm-btn" id="tm-btn-abort">⏹️ Arrêter</button>
        <div id="tm-monitor"><p id="tm-console">Prêt à démarrer.</p><div class="tm-track"><div class="tm-fill" id="tm-fill"></div></div></div>
      `;

      document.body.appendChild(this.panel);
      document.getElementById('tm-close').onclick = () => { window._tmStop = true; this.panel.remove(); };
      document.getElementById('tm-btn-abort').onclick = () => { window._tmStop = true; };
    },

    setStatus(html, color = '#A0A0A0') {
      const el = document.getElementById('tm-console');
      if (el) { el.style.color = color; el.innerHTML = html; }
    },

    setProgress(current, total) {
      const el = document.getElementById('tm-fill');
      if (el && typeof total === 'number' && total > 0) el.style.width = Math.round((current / total) * 100) + '%';
    },

    setIsProcessing(state) {
      const pBtn = document.getElementById('tm-btn-primary');
      const aBtn = document.getElementById('tm-btn-abort');
      if (pBtn) pBtn.disabled = state;
      if (pBtn) pBtn.style.display = state ? 'none' : 'flex';
      if (aBtn) aBtn.style.display = state ? 'flex' : 'none';
    },

    formatStats(stats) {
      return `Abonnés: <strong>${stats.done}</strong> | Déjà suivis: <strong>${stats.already}</strong><br>Attente: <strong>${stats.pending}</strong> | Erreurs: <strong>${stats.failed}</strong>`;
    }
  };

  const Controllers = {
    async runSourceCapture() {
      window._tmStop = false;
      UI.setIsProcessing(true);
      UI.setStatus('Authentification en cours...');

      let totalToScan = '?';
      try {
        const infoRes = await fetch(`https://www.instagram.com/api/v1/users/${Tokens.getIgUserId()}/info/`, {
          headers: { 'X-IG-App-ID': CONFIG.API.IG_APP_ID }
        });
        const infoData = await infoRes.json();
        if (infoData?.user?.following_count) totalToScan = infoData.user.following_count;
      } catch (e) { }

      try {
        const pks = await InstagramAPI.collectAll(totalToScan, async (currentCount, totalCount, username) => {
          UI.setStatus(`Importation: <strong>${currentCount}/${totalCount}</strong><br>En cours: @${username}`, '#FAFAFA');
          UI.setProgress(currentCount, totalCount);
          await sleep(5);
        });

        if (window._tmStop || !pks.length) {
          UI.setStatus(pks.length ? 'Arrêté manuellement.' : 'Aucun abonnement trouvé.', '#ffaa00');
          UI.setIsProcessing(false);
          return;
        }

        UI.setStatus(`Génial ! <strong>${pks.length}</strong> comptes identifiés.<br>Ouverture de Threads...`, '#66ff66');
        UI.setProgress(1, 1);
        await sleep(2000);
        window.location.href = `https://www.threads.com/#${CONFIG.KEYS.HASH}=${CrossDomainSync.encode(pks)}`;
      } catch (e) {
        UI.setStatus(`Erreur HTTP: ${e.message}`, '#ff4444');
        UI.setIsProcessing(false);
      }
    },

    async runTargetCycle(pks) {
      window._tmStop = false;
      UI.setIsProcessing(true);

      if (!Tokens.getCsrf()) {
        UI.setStatus('Aucun compte détecté. Êtes-vous connecté sur Threads ?', '#ff4444');
        UI.setIsProcessing(false);
        return;
      }
      if (!Tokens.getLsd()) await sleep(2000);

      UI.setStatus(`Préparation de <strong>${pks.length}</strong> abonnements...`, '#FAFAFA');
      await sleep(1000);

      const stats = await Engine.runFollowCycle(pks, (result, s, username) => {
        const t = STATE_THEMES[result];
        const processed = s.done + s.already + s.pending + s.failed;
        UI.setStatus(`${t.icon} <strong>${processed}/${s.total}</strong> (@${username})<br>${UI.formatStats(s)}`, t.color);
        UI.setProgress(processed, s.total);
      });

      const term = window._tmStop ? 'Arrêté manuellement.' : 'Terminé avec succès !';
      const c = window._tmStop ? '#ffaa00' : '#66ff66';
      UI.setStatus(`${term}<br>${UI.formatStats(stats)}`, c);
      UI.setProgress(1, 1);
      UI.setIsProcessing(false);
    }
  };

  function bootstrap() {
    if (!document.body) return;

    if (ENV.IS_INSTAGRAM) {
      setTimeout(() => {
        UI.init(1);
        document.getElementById('tm-btn-primary').onclick = Controllers.runSourceCapture;
      }, 1500);
    }

    if (ENV.IS_THREADS) {
      const pks = CrossDomainSync.decode(ENV.RAW_HASH);
      if (pks?.length) {
        CrossDomainSync.cleanHash();
        setTimeout(() => {
          UI.init(2);
          UI.setStatus(`Nous avons importé <strong>${pks.length}</strong> comptes depuis Instagram.`, '#FAFAFA');
          document.getElementById('tm-btn-primary').onclick = () => Controllers.runTargetCycle(pks);
        }, 1500);
        return;
      }

      setTimeout(() => {
        UI.init(2);
        UI.setStatus('Ouvrez Instagram (Étape 1) en premier pour récupérer vos abonnements.');
        document.getElementById('tm-btn-primary').disabled = true;
      }, 1500);
    }
  }

  const routerPush = history.pushState.bind(history);
  history.pushState = (...args) => { routerPush(...args); setTimeout(bootstrap, 1500); };
  window.addEventListener('popstate', () => setTimeout(bootstrap, 1500));

  bootstrap();

})();
