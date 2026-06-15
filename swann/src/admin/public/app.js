/*
 * Swann admin UI — vanilla JS, no build step.
 *
 * Polls GET api/state and renders players / credentials / activity. All fetch
 * URLs are RELATIVE (no leading slash) so they resolve against <base href>,
 * which the server templates from the X-Ingress-Path header. This is what makes
 * the UI work unchanged behind Home Assistant Ingress.
 */
(function () {
  'use strict';

  var POLL_MS = 2000;
  var els = {
    conn: document.getElementById('conn'),
    uptime: document.getElementById('uptime'),
    players: document.getElementById('players'),
    credentials: document.getElementById('credentials'),
    activity: document.getElementById('activity'),
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtDuration(ms) {
    if (!ms || ms <= 0) return 'live';
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    var h = Math.floor(m / 60);
    var sec = String(s % 60).padStart(2, '0');
    if (h > 0) return h + ':' + String(m % 60).padStart(2, '0') + ':' + sec;
    return m + ':' + sec;
  }

  function fmtUptime(sec) {
    if (sec == null) return '';
    var d = Math.floor(sec / 86400);
    var h = Math.floor((sec % 86400) / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var parts = [];
    if (d) parts.push(d + 'd');
    if (h) parts.push(h + 'h');
    parts.push(m + 'm');
    return 'up ' + parts.join(' ');
  }

  function fmtTime(at) {
    try {
      return new Date(at).toLocaleTimeString();
    } catch (_e) {
      return '';
    }
  }

  // Resolve API calls relative to <base href> regardless of how the page loads.
  function apiUrl(path) {
    return new URL(path, document.baseURI).toString();
  }

  function post(path) {
    return fetch(apiUrl(path), { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  }

  function postVolume(guildId, volume) {
    return fetch(apiUrl('api/guilds/' + encodeURIComponent(guildId) + '/volume'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ volume: volume }),
    });
  }

  function statusPill(status) {
    var cls = 'pill-muted';
    if (status === 'playing') cls = 'pill-ok';
    else if (status === 'paused') cls = 'pill-warn';
    else if (status === 'disconnected') cls = 'pill-err';
    return '<span class="pill ' + cls + '">' + esc(status) + '</span>';
  }

  function renderPlayer(p) {
    var now = p.current
      ? '<div class="now">' +
        '<div class="now-title">' + esc(p.current.track.title) + '</div>' +
        '<div class="now-meta">' + esc(p.current.track.author) +
        ' · ' + fmtDuration(p.positionMs) + ' / ' + fmtDuration(p.current.track.durationMs) +
        ' · req. ' + esc(p.current.requestedByName) + '</div>' +
        '</div>'
      : '<div class="now muted">Nothing playing</div>';

    var queue = '';
    if (p.queue && p.queue.length) {
      queue =
        '<ol class="queue">' +
        p.queue
          .slice(0, 10)
          .map(function (q) {
            return '<li><span class="q-title">' + esc(q.track.title) + '</span>' +
              '<span class="q-author">' + esc(q.track.author) + '</span></li>';
          })
          .join('') +
        '</ol>';
      if (p.queue.length > 10) {
        queue += '<p class="muted">+ ' + (p.queue.length - 10) + ' more</p>';
      }
    } else {
      queue = '<p class="muted">Queue empty</p>';
    }

    var gid = p.guildId;
    var controls =
      '<div class="controls" data-guild="' + esc(gid) + '">' +
      (p.paused
        ? '<button data-act="resume">▶ Resume</button>'
        : '<button data-act="pause">⏸ Pause</button>') +
      '<button data-act="skip">⏭ Skip</button>' +
      '<button data-act="stop" class="danger">⏹ Stop</button>' +
      '<label class="vol">Vol ' +
      '<input type="range" min="0" max="100" value="' + esc(p.volume) + '" data-act="volume" />' +
      '<span class="vol-val">' + esc(p.volume) + '</span></label>' +
      '<span class="loop">loop: ' + esc(p.loop) + '</span>' +
      '</div>';

    return (
      '<article class="player">' +
      '<div class="player-head"><span class="gid">guild ' + esc(gid) + '</span>' +
      statusPill(p.status) + '</div>' +
      now +
      controls +
      '<h3>Queue (' + (p.queue ? p.queue.length : 0) + ')</h3>' +
      queue +
      '</article>'
    );
  }

  function renderPlayers(players) {
    if (!players || !players.length) {
      els.players.innerHTML = '<p class="muted">No active players. Use /play in Discord.</p>';
      return;
    }
    els.players.innerHTML = players.map(renderPlayer).join('');
  }

  var CRED_LABELS = {
    discordToken: 'Discord token',
    discordAppId: 'Discord app id',
    mistralApiKey: 'Mistral API key',
    kwsModel: 'Wake-word model (KWS)',
    sileroModel: 'Silero VAD model',
    ytdlpAvailable: 'yt-dlp available',
  };

  function renderCredentials(cfg) {
    if (!cfg) {
      els.credentials.innerHTML = '<li class="muted">No data</li>';
      return;
    }
    els.credentials.innerHTML = Object.keys(CRED_LABELS)
      .map(function (key) {
        var ok = !!cfg[key];
        return (
          '<li><span class="dot ' + (ok ? 'dot-ok' : 'dot-err') + '"></span>' +
          esc(CRED_LABELS[key]) +
          '<span class="cred-state ' + (ok ? 'ok' : 'err') + '">' +
          (ok ? 'configured' : 'missing') +
          '</span></li>'
        );
      })
      .join('');
  }

  function renderActivity(items) {
    if (!items || !items.length) {
      els.activity.innerHTML = '<li class="muted">No recent activity</li>';
      return;
    }
    els.activity.innerHTML = items
      .slice(0, 30)
      .map(function (a) {
        return (
          '<li><span class="act-time">' + esc(fmtTime(a.at)) + '</span>' +
          '<span class="act-kind kind-' + esc(a.kind) + '">' + esc(a.kind) + '</span>' +
          '<span class="act-msg">' + esc(a.message) + '</span></li>'
        );
      })
      .join('');
  }

  function setConn(ok) {
    els.conn.textContent = ok ? 'live' : 'offline';
    els.conn.className = 'pill ' + (ok ? 'pill-ok' : 'pill-err');
  }

  function refresh() {
    return fetch(apiUrl('api/state'), { headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (state) {
        setConn(true);
        els.uptime.textContent = fmtUptime(state.uptimeSec);
        renderPlayers(state.players);
        renderCredentials(state.config);
        renderActivity(state.activity);
      })
      .catch(function () {
        setConn(false);
      });
  }

  // Event delegation for the control buttons / volume sliders.
  els.players.addEventListener('click', function (ev) {
    var btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    var wrap = btn.closest('.controls');
    if (!wrap) return;
    var gid = wrap.getAttribute('data-guild');
    var act = btn.getAttribute('data-act');
    if (!gid || !act) return;
    btn.disabled = true;
    post('api/guilds/' + encodeURIComponent(gid) + '/' + act)
      .catch(function () {})
      .then(function () {
        return refresh();
      })
      .then(function () {
        btn.disabled = false;
      });
  });

  els.players.addEventListener('input', function (ev) {
    var slider = ev.target.closest('input[data-act="volume"]');
    if (!slider) return;
    var wrap = slider.closest('.controls');
    var label = wrap ? wrap.querySelector('.vol-val') : null;
    if (label) label.textContent = slider.value;
  });

  els.players.addEventListener('change', function (ev) {
    var slider = ev.target.closest('input[data-act="volume"]');
    if (!slider) return;
    var wrap = slider.closest('.controls');
    if (!wrap) return;
    var gid = wrap.getAttribute('data-guild');
    if (!gid) return;
    postVolume(gid, parseInt(slider.value, 10)).catch(function () {});
  });

  refresh();
  setInterval(refresh, POLL_MS);
})();
