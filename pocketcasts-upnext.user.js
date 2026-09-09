// ==UserScript==
// @name         Pocket Casts — spread shuffle Up Next
// @namespace    https://github.com/turquoise-turtle/shuffle-spread
// @version      0.3.0
// @description  Take a running order from shuffle-spread and build it into a Pocket Casts Up Next queue or manual playlist
// @author       turquoise-turtle
// @homepageURL  https://github.com/turquoise-turtle/shuffle-spread
// @supportURL   https://github.com/turquoise-turtle/shuffle-spread/issues
// @downloadURL  https://raw.githubusercontent.com/turquoise-turtle/shuffle-spread/master/pocketcasts-upnext.user.js
// @updateURL    https://raw.githubusercontent.com/turquoise-turtle/shuffle-spread/master/pocketcasts-upnext.user.js
// @match        https://pocketcasts.com/*
// @match        https://play.pocketcasts.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
	'use strict';

	var API = 'https://api.pocketcasts.com';
	var CACHE = 'https://cache.pocketcasts.com';
	var PAGE = 'https://turquoise-turtle.github.io/shuffle-spread/';
	var BACKUP = 'spread-shuffle.upnext-backup';
	var INCLUDED = 'spread-shuffle.included';
	var PL_BACKUP = 'spread-shuffle.playlist-backup';

	var PLAYED = 3; // EpisodePlayingStatus: 1 not played, 2 in progress, 3 completed
	var REPLACE = 5; // UpNextChange.ACTION_REPLACE

	/* ---------------------------------------------------------------
	 * Auth
	 *
	 * The player is already signed in, so rather than asking for a
	 * password we watch its own requests go past and lift the bearer
	 * token off them. Hence @run-at document-start.
	 * ------------------------------------------------------------- */

	var token = null;

	function noteAuth(value) {
		if (typeof value === 'string' && /^Bearer\s+\S/i.test(value)) {
			token = value.replace(/^Bearer\s+/i, '');
		}
	}

	var nativeFetch = window.fetch;
	window.fetch = function (input, init) {
		try {
			var headers = (init && init.headers) ||
				(typeof Request !== 'undefined' && input instanceof Request ? input.headers : null);
			if (headers) noteAuth(new Headers(headers).get('Authorization'));
		} catch (e) { /* never break the player over this */ }
		return nativeFetch.apply(this, arguments);
	};

	var nativeSetHeader = XMLHttpRequest.prototype.setRequestHeader;
	XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
		if (String(name).toLowerCase() === 'authorization') noteAuth(value);
		return nativeSetHeader.apply(this, arguments);
	};

	// Fallback for a quiet page: the token is usually sitting in storage too.
	function tokenFromStorage() {
		var stores = [localStorage, sessionStorage];
		var jwt = /ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

		for (var s = 0; s < stores.length; s++) {
			for (var i = 0; i < stores[s].length; i++) {
				var raw;
				try {
					raw = stores[s].getItem(stores[s].key(i));
				} catch (e) {
					continue;
				}
				var hit = raw && raw.match(jwt);
				if (hit) return hit[0];
			}
		}
		return null;
	}

	function requireToken() {
		if (!token) token = tokenFromStorage();
		if (!token) {
			throw new Error(
				'Could not find a login token. Make sure you are signed in, then ' +
				'reload the page with this script active and try again.'
			);
		}
		return token;
	}

	/* ---------------------------------------------------------------
	 * API
	 * ------------------------------------------------------------- */

	function api(path, body, method) {
		return fetch(API + path, {
			method: method || (body === undefined ? 'GET' : 'POST'),
			headers: {
				'Authorization': 'Bearer ' + requireToken(),
				'Content-Type': 'application/json'
			},
			body: body === undefined ? undefined : JSON.stringify(body)
		}).then(function (res) {
			var type = res.headers.get('content-type') || '';
			if (!res.ok) {
				return res.text().then(function (text) {
					throw new Error(path + ' → HTTP ' + res.status + ' ' + text.slice(0, 200));
				});
			}
			if (type.indexOf('json') === -1) {
				throw new Error(path + ' returned ' + (type || 'no content-type') + ', not JSON');
			}
			return res.json();
		});
	}

	function loadPodcasts() {
		return api('/user/podcast/list', { v: 1 }).then(function (data) {
			return (data.podcasts || []).map(function (p) {
				return { uuid: p.uuid, title: p.title || p.uuid };
			}).filter(function (p) { return p.uuid; });
		});
	}

	// Everything in the public feed, minus anything played or archived.
	// Oldest first, because that is the order you would work through them.
	function loadUnplayed(podcast) {
		var feed = fetch(CACHE + '/mobile/podcast/full/' + podcast.uuid)
			.then(function (r) { return r.ok ? r.json() : { podcast: {} }; })
			.catch(function () { return { podcast: {} }; });

		var mine = api('/user/podcast/episodes', { uuid: podcast.uuid })
			.catch(function () { return null; });

		return Promise.all([feed, mine]).then(function (both) {
			var show = both[0].podcast || {};
			var all = show.episodes || [];

			// Without play state we would queue up things already listened to,
			// so treat that as a failure rather than quietly queueing everything.
			if (!both[1]) throw new Error('Could not read play state for ' + podcast.title);

			var state = {};
			(both[1].episodes || []).forEach(function (e) { state[e.uuid] = e; });

			return all.filter(function (ep) {
				var s = state[ep.uuid];
				if (!s) return true;              // never touched
				if (s.isDeleted) return false;    // archived
				return s.playingStatus !== PLAYED;
			}).sort(function (a, b) {
				// The feed arrives newest first and we want the opposite. Parse
				// rather than compare strings: most feeds use Z-suffixed UTC, but
				// an offset like +10:00 would sort wrongly as text.
				var ta = Date.parse(a.published);
				var tb = Date.parse(b.published);
				if (isNaN(ta) || isNaN(tb)) {
					return String(a.published).localeCompare(String(b.published));
				}
				return ta - tb || (a.season - b.season) || (a.number - b.number);
			}).map(function (ep) {
				return {
					uuid: ep.uuid,
					title: ep.title || '',
					url: ep.url || '',
					published: ep.published || '',
					podcast: podcast.uuid,
					showTitle: podcast.title,
					type: ep.type || 'full',
					// playlist entries carry slugs; Up Next does not
					slug: ep.slug || '',
					podcastSlug: show.slug || ''
				};
			});
		});
	}

	/* ---------------------------------------------------------------
	 * Up Next
	 *
	 * The web player only ever reads through /up_next/sync and makes its
	 * changes one episode at a time via /up_next/play_last and friends.
	 * The apps can also push a whole queue in one go by sending a change
	 * list to /up_next/sync with action 5, which is what we try first --
	 * then check it actually landed, and fall back to appending if not.
	 * ------------------------------------------------------------- */

	var serverModified = '0';

	function readUpNext() {
		return api('/up_next/sync', {
			version: 2,
			model: 'webplayer',
			serverModified: serverModified,
			showPlayStatus: true
		}).then(function (data) {
			if (data.serverModified) serverModified = String(data.serverModified);
			return data;
		});
	}

	function bare(e) {
		return {
			uuid: e.uuid,
			title: e.title,
			url: e.url,
			podcast: e.podcast,
			published: e.published
		};
	}

	function syncReplace(episodes) {
		var now = Date.now();
		return api('/up_next/sync', {
			deviceTime: now,
			version: '2',
			upNext: {
				serverModified: Number(serverModified) || 0,
				changes: [{
					action: REPLACE,
					modified: now,
					episodes: episodes.map(bare)
				}]
			}
		});
	}

	function playLast(episode) {
		return api('/up_next/play_last', { version: 2, episode: bare(episode) });
	}

	// Did the queue actually end up holding what we asked for? Allow one
	// extra, since whatever is playing stays pinned to the front.
	function queueMatches(queue, wanted) {
		var present = {};
		(queue || []).forEach(function (e) { present[e.uuid] = true; });
		return queue.length <= wanted.length + 1 && wanted.every(function (e) {
			return present[e.uuid];
		});
	}

	function appendEach(episodes, onProgress) {
		return episodes.reduce(function (chain, episode, i) {
			return chain.then(function () {
				if (onProgress) onProgress(i + 1, episodes.length);
				return playLast(episode);
			});
		}, Promise.resolve());
	}

	/* ---------------------------------------------------------------
	 * Playlists
	 *
	 * Only "manual" playlists hold episodes you put there by hand; the
	 * rest are saved filters whose contents the server works out, so
	 * writing episodes to one would be meaningless.
	 *
	 * Adding is a PUT to .../playlists/{playlist}/episode/{episode} whose
	 * body is the whole playlist. `episodeOrder` is what actually decides
	 * the order -- `episodes` is just the bag of records it points into.
	 * ------------------------------------------------------------- */

	function loadPlaylists() {
		return api('/user/playlists').then(function (data) {
			return (data.playlists || []).filter(function (p) {
				return p.manual && !p.isDeleted;
			});
		});
	}

	function playlistEntry(episode) {
		return {
			episode: episode.uuid,
			podcast: episode.podcast,
			added: String(Date.now()),
			published: episode.published,
			title: episode.title,
			url: episode.url,
			podcastSlug: episode.podcastSlug || '',
			episodeSlug: episode.slug || ''
		};
	}

	// Returns the playlist as it should end up, leaving the server's own
	// fields (filters, icon, sort) exactly as we found them.
	function playlistWith(playlist, episodes, keepExisting) {
		var body = {};
		Object.keys(playlist).forEach(function (k) { body[k] = playlist[k]; });

		var entries = [];
		var order = [];
		var seen = {};

		function take(entry, uuid) {
			if (seen[uuid]) return;
			seen[uuid] = true;
			entries.push(entry);
			order.push(uuid);
		}

		episodes.forEach(function (ep) { take(playlistEntry(ep), ep.uuid); });

		if (keepExisting) {
			(playlist.episodeOrder || []).forEach(function (uuid) {
				var existing = (playlist.episodes || []).filter(function (e) {
					return e.episode === uuid;
				})[0];
				if (existing) take(existing, uuid);
			});
		}

		body.episodes = entries;
		body.episodeOrder = order;
		return body;
	}

	function putPlaylist(body, episodeUuid) {
		return api('/user/playlists/' + body.uuid + '/episode/' + episodeUuid, body, 'PUT');
	}

	function readPlaylist(uuid) {
		return loadPlaylists().then(function (list) {
			return list.filter(function (p) { return p.uuid === uuid; })[0] || null;
		});
	}

	/* ---------------------------------------------------------------
	 * State
	 * ------------------------------------------------------------- */

	var podcasts = [];   // every subscription: [{uuid, title, use}]
	var playlists = [];  // manual playlists the order can be written to
	var shows = [];      // the ticked ones, once counted: [{uuid, title, episodes}]
	var resolved = [];   // episodes in shuffled order, ready to write

	// Whitelist: a show joins the shuffle only once you tick it, so a podcast
	// you subscribe to later cannot quietly dump its backlog into the queue.
	function includedSet() {
		try {
			var raw = localStorage.getItem(INCLUDED);
			var list = raw ? JSON.parse(raw) : [];
			var set = {};
			(Array.isArray(list) ? list : []).forEach(function (u) { set[u] = true; });
			return set;
		} catch (e) {
			return {};
		}
	}

	function saveIncluded() {
		try {
			localStorage.setItem(INCLUDED, JSON.stringify(
				podcasts.filter(function (p) { return p.use; }).map(function (p) { return p.uuid; })
			));
		} catch (e) { /* best effort */ }
	}

	function stash(episodes) {
		try {
			localStorage.setItem(BACKUP, JSON.stringify({ at: Date.now(), episodes: episodes }));
		} catch (e) { /* best effort */ }
	}

	function readStash() {
		try {
			var raw = localStorage.getItem(BACKUP);
			return raw ? JSON.parse(raw) : null;
		} catch (e) {
			return null;
		}
	}

	// A line is "<key>\t<index>\t<title>"; key is a podcast uuid, index is
	// 1-based into that show's unplayed list. Also accepts the older
	// "casefile3" run-together form, matched against show titles.
	function parseOrder(text) {
		var byUuid = {};
		var bySlug = {};
		shows.forEach(function (s) {
			byUuid[s.uuid] = s;
			bySlug[s.title.toLowerCase().replace(/[^a-z0-9]+/g, '')] = s;
		});

		var out = [];
		var missing = [];
		var dropped = 0;

		text.split('\n').forEach(function (line) {
			line = line.trim();
			if (!line) return;

			var key, index;
			var tabbed = line.split('\t');

			if (tabbed.length >= 2) {
				key = tabbed[0].trim();
				index = parseInt(tabbed[1], 10);
			} else {
				var run = /^([a-z0-9]*?)(\d+)$/i.exec(line.replace(/\s+/g, ''));
				if (!run) return;
				key = run[1].toLowerCase();
				index = parseInt(run[2], 10);
			}

			var show = byUuid[key] || bySlug[String(key).toLowerCase().replace(/[^a-z0-9]+/g, '')];
			if (!show) {
				if (missing.indexOf(key) === -1) missing.push(key);
				return;
			}

			var episode = show.episodes[index - 1];
			if (episode) out.push(episode);
			else dropped++; // the show has fewer episodes left than the order expects
		});

		return { episodes: out, missing: missing, dropped: dropped };
	}

	/* ---------------------------------------------------------------
	 * UI
	 * ------------------------------------------------------------- */

	var ui = {};

	var CSS = [
		':host{all:initial}',
		'*{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}',
		'.launch{position:fixed;right:18px;bottom:18px;z-index:2147483646;padding:10px 14px;',
		'border:0;border-radius:999px;background:#f43e37;color:#fff;font-size:13px;font-weight:600;',
		'cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35)}',
		'.panel{position:fixed;right:18px;bottom:70px;z-index:2147483647;width:380px;max-height:76vh;',
		'display:none;flex-direction:column;background:#1a1a1e;color:#eee;border:1px solid #3a3a42;',
		'border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.5);font-size:13px;overflow:hidden}',
		'.panel.open{display:flex}',
		'header{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;',
		'border-bottom:1px solid #3a3a42;font-weight:600}',
		'header button{background:none;border:0;color:#999;font-size:18px;cursor:pointer;line-height:1}',
		'.body{padding:12px 14px;overflow-y:auto;flex:1}',
		'h4{margin:14px 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:#8a8a94}',
		'h4:first-child{margin-top:0}',
		'button.act{padding:7px 11px;border:1px solid #4a4a54;border-radius:6px;background:#26262c;',
		'color:#eee;font-size:12px;cursor:pointer;margin:0 6px 6px 0}',
		'button.act:hover{border-color:#777}',
		'button.act.go{background:#f43e37;border-color:transparent;color:#fff;font-weight:600}',
		'button.act.warn{background:#5a2d2b;border-color:#7d3b38;color:#ffd9d7}',
		'button.act:disabled{opacity:.45;cursor:default}',
		'.dest{width:100%;padding:6px 8px;margin:0 0 6px;border:1px solid #3a3a42;',
		'border-radius:6px;background:#26262c;color:#eee;font-size:12px}',
		'.filter{width:100%;padding:6px 8px;margin:2px 0 6px;border:1px solid #3a3a42;',
		'border-radius:6px;background:#111114;color:#ddd;font-size:12px}',
		'textarea{width:100%;height:88px;padding:8px;border:1px solid #3a3a42;border-radius:6px;',
		'background:#111114;color:#ddd;font:12px/1.4 ui-monospace,Menlo,monospace;resize:vertical}',
		'label.show{display:flex;align-items:center;gap:8px;padding:3px 0}',
		'label.show span.n{margin-left:auto;color:#8a8a94;font-variant-numeric:tabular-nums}',
		'ol{margin:0;padding-left:26px;max-height:210px;overflow-y:auto}',
		'ol li{padding:2px 0;color:#b8b8c0}',
		'ol li b{color:#eee;font-weight:500}',
		'.note{color:#8a8a94;margin:6px 0 0;line-height:1.45}',
		'.err{color:#ff9a95;margin:6px 0 0;line-height:1.45;white-space:pre-wrap}',
		'.ok{color:#7fd6a2}'
	].join('');

	function el(tag, props, kids) {
		var node = document.createElement(tag);
		Object.keys(props || {}).forEach(function (k) {
			if (k === 'class') node.className = props[k];
			else if (k === 'text') node.textContent = props[k];
			else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), props[k]);
			else node.setAttribute(k, props[k]);
		});
		(kids || []).forEach(function (kid) { node.appendChild(kid); });
		return node;
	}

	function say(message, kind) {
		ui.status.className = kind === 'error' ? 'err' : (kind === 'ok' ? 'note ok' : 'note');
		ui.status.textContent = message || '';
	}

	function build() {
		var host = document.createElement('div');
		document.body.appendChild(host);
		var root = host.attachShadow({ mode: 'open' });
		root.appendChild(el('style', { text: CSS }));

		var panel = el('div', { class: 'panel' });

		panel.appendChild(el('header', {}, [
			el('span', { text: 'Spread shuffle' }),
			el('button', { text: '×', title: 'Close', onclick: function () { panel.classList.remove('open'); } })
		]));

		var body = el('div', { class: 'body' });

		body.appendChild(el('h4', { text: '1 · Your shows' }));
		ui.loadBtn = el('button', { class: 'act', text: 'Load subscriptions', onclick: doLoadPodcasts });
		body.appendChild(ui.loadBtn);

		ui.filter = el('input', { type: 'search', class: 'filter', placeholder: 'Filter…' });
		ui.filter.addEventListener('input', renderPodcasts);
		ui.filter.hidden = true;
		body.appendChild(ui.filter);

		ui.shows = el('div');
		body.appendChild(ui.shows);
		ui.tally = el('p', { class: 'note' });
		body.appendChild(ui.tally);
		ui.handoff = el('div');
		body.appendChild(ui.handoff);

		body.appendChild(el('h4', { text: '2 · Running order' }));
		ui.dest = el('select', { class: 'dest' });
		ui.dest.appendChild(el('option', { value: 'upnext', text: 'Up Next' }));
		ui.dest.addEventListener('change', function () {
			if (resolved.length) doPreview();
		});
		body.appendChild(ui.dest);

		ui.paste = el('textarea', { placeholder: 'Paste the copied running order from the shuffle page…' });
		body.appendChild(ui.paste);
		body.appendChild(el('button', { class: 'act', text: 'Preview', onclick: doPreview }));

		ui.preview = el('div');
		body.appendChild(ui.preview);

		ui.status = el('p', { class: 'note' });
		body.appendChild(ui.status);

		ui.undo = el('div');
		body.appendChild(ui.undo);

		panel.appendChild(body);
		root.appendChild(panel);

		root.appendChild(el('button', {
			class: 'launch',
			text: 'Spread shuffle',
			onclick: function () {
				panel.classList.toggle('open');
				renderUndo();
			}
		}));

		renderUndo();
	}

	function readPlaylistStash() {
		try {
			var raw = localStorage.getItem(PL_BACKUP);
			return raw ? JSON.parse(raw) : null;
		} catch (e) {
			return null;
		}
	}

	function renderUndo() {
		ui.undo.textContent = '';
		renderPlaylistUndo();

		var backup = readStash();
		if (!backup || !backup.episodes || !backup.episodes.length) return;

		ui.undo.appendChild(el('h4', { text: 'Backup' }));
		ui.undo.appendChild(el('button', {
			class: 'act warn',
			text: 'Restore previous queue (' + backup.episodes.length + ')',
			onclick: function () {
				say('Restoring…');
				syncReplace(backup.episodes).then(readUpNext).then(function (after) {
					if (queueMatches(after.episodes || [], backup.episodes)) {
						say('Previous queue restored. Reload to see it.', 'ok');
					} else {
						say('Restore did not take. Clear Up Next in the player, then ' +
							'press this again.', 'error');
					}
				}).catch(function (e) { say(e.message, 'error'); });
			}
		}));
		ui.undo.appendChild(el('p', {
			class: 'note',
			text: 'Up Next saved ' + new Date(backup.at).toLocaleString() + '.'
		}));
	}

	function renderPlaylistUndo() {
		var backup = readPlaylistStash();
		if (!backup || !backup.uuid) return;

		ui.undo.appendChild(el('h4', { text: 'Backup' }));
		ui.undo.appendChild(el('button', {
			class: 'act warn',
			text: 'Restore "' + backup.title + '" (' + (backup.episodeOrder || []).length + ')',
			onclick: function () {
				say('Restoring "' + backup.title + '"…');
				readPlaylist(backup.uuid).then(function (current) {
					if (!current) throw new Error('That playlist has gone.');
					var body = {};
					Object.keys(current).forEach(function (k) { body[k] = current[k]; });
					body.episodes = backup.episodes;
					body.episodeOrder = backup.episodeOrder;

					var last = body.episodeOrder[body.episodeOrder.length - 1] ||
						(current.episodeOrder || [])[0];
					if (!last) throw new Error('Nothing to restore onto.');

					return putPlaylist(body, last);
				}).then(function () {
					say('"' + backup.title + '" restored.', 'ok');
				}).catch(function (e) {
					say(e.message, 'error');
				});
			}
		}));
	}

	function doLoadPodcasts() {
		ui.loadBtn.disabled = true;
		say('Loading your subscriptions…');

		loadPodcasts().then(function (list) {
			var included = includedSet();
			podcasts = list.map(function (p) {
				return { uuid: p.uuid, title: p.title, use: !!included[p.uuid] };
			}).sort(function (a, b) { return a.title.localeCompare(b.title); });

			shows = [];
			ui.filter.hidden = false;
			renderPodcasts();
			refreshDestinations();

			var ticked = podcasts.filter(function (p) { return p.use; }).length;
			say(ticked
				? podcasts.length + ' subscriptions, ' + ticked + ' already ticked.'
				: podcasts.length + ' subscriptions. Tick the ones you are working through.', 'ok');
		}).catch(function (e) {
			say(e.message, 'error');
		}).then(function () {
			ui.loadBtn.disabled = false;
		});
	}

	// Manual playlists are a second place the running order can go.
	function refreshDestinations() {
		loadPlaylists().then(function (list) {
			playlists = list;
			var chosen = ui.dest.value;
			ui.dest.textContent = '';
			ui.dest.appendChild(el('option', { value: 'upnext', text: 'Up Next' }));
			playlists.forEach(function (p) {
				ui.dest.appendChild(el('option', { value: p.uuid, text: 'Playlist: ' + p.title }));
			});
			ui.dest.value = chosen;
			if (!ui.dest.value) ui.dest.value = 'upnext';
		}).catch(function () {
			// no playlists is not an error; Up Next still works
		});
	}

	function renderPodcasts() {
		ui.shows.textContent = '';
		ui.handoff.textContent = '';
		if (!podcasts.length) return;

		var needle = (ui.filter.value || '').trim().toLowerCase();

		podcasts.forEach(function (podcast) {
			if (needle && podcast.title.toLowerCase().indexOf(needle) === -1) return;

			var box = el('input', { type: 'checkbox' });
			box.checked = podcast.use;
			box.addEventListener('change', function () {
				podcast.use = box.checked;
				saveIncluded();
				renderTally();
			});

			var counted = countFor(podcast.uuid);
			ui.shows.appendChild(el('label', { class: 'show' }, [
				box,
				el('span', { text: podcast.title }),
				el('span', { class: 'n', text: counted === null ? '' : String(counted) })
			]));
		});

		renderTally();
	}

	function countFor(uuid) {
		for (var i = 0; i < shows.length; i++) {
			if (shows[i].uuid === uuid) return shows[i].episodes.length;
		}
		return null;
	}

	function renderTally() {
		ui.tally.textContent = '';
		ui.handoff.textContent = '';

		var ticked = podcasts.filter(function (p) { return p.use; });
		if (!ticked.length) {
			ui.tally.textContent = 'Nothing ticked yet.';
			return;
		}

		var total = shows.reduce(function (n, s) { return n + s.episodes.length; }, 0);
		ui.tally.textContent = shows.length
			? ticked.length + ' ticked · ' + total + ' episodes left'
			: ticked.length + ' ticked';

		// Counting hits the network twice per show, so only ever do it for the
		// ticked ones -- and only when asked.
		ui.handoff.appendChild(el('button', {
			class: 'act',
			text: shows.length ? 'Recount episodes' : 'Count episodes for these ' + ticked.length,
			onclick: doCountEpisodes
		}));

		if (!shows.length) return;

		ui.handoff.appendChild(el('button', {
			class: 'act go',
			text: 'Open shuffle page',
			onclick: function () {
				var payload = shows.map(function (s) {
					return { k: s.uuid, t: s.title, n: s.episodes.length };
				});
				window.open(PAGE + '#shows=' + encodeURIComponent(JSON.stringify(payload)), '_blank');
			}
		}));
	}

	function doCountEpisodes() {
		var ticked = podcasts.filter(function (p) { return p.use; });
		if (!ticked.length) return;

		say('Counting unplayed episodes across ' + ticked.length + ' shows…');

		Promise.all(ticked.map(function (p) {
			return loadUnplayed(p).then(function (episodes) {
				return { uuid: p.uuid, title: p.title, episodes: episodes };
			});
		})).then(function (list) {
			shows = list.filter(function (s) { return s.episodes.length; });
			renderPodcasts();

			var total = shows.reduce(function (n, s) { return n + s.episodes.length; }, 0);
			var empty = list.length - shows.length;
			say(total + ' episodes across ' + shows.length + ' shows' +
				(empty ? ' (' + empty + ' had nothing left)' : '') + '.', 'ok');
		}).catch(function (e) {
			say(e.message, 'error');
		});
	}

	function doPreview() {
		if (!shows.length) {
			say('Load your shows first — the order refers to them by id.', 'error');
			return;
		}

		var parsed = parseOrder(ui.paste.value);
		resolved = parsed.episodes;
		ui.preview.textContent = '';

		if (!resolved.length) {
			say('Nothing recognised in that paste.', 'error');
			return;
		}

		var list = el('ol');
		resolved.forEach(function (ep) {
			list.appendChild(el('li', {}, [
				el('b', { text: ep.showTitle }),
				el('span', { text: ' — ' + ep.title })
			]));
		});
		ui.preview.appendChild(list);

		var playlist = chosenPlaylist();
		if (playlist) {
			ui.preview.appendChild(el('button', {
				class: 'act go',
				text: 'Add ' + resolved.length + ' to "' + playlist.title + '"',
				onclick: function () { doWritePlaylist(playlist, true); }
			}));
			ui.preview.appendChild(el('button', {
				class: 'act warn',
				text: 'Replace "' + playlist.title + '"',
				onclick: function () { doWritePlaylist(playlist, false); }
			}));
		} else {
			ui.preview.appendChild(el('button', {
				class: 'act go',
				text: 'Replace Up Next with these ' + resolved.length,
				onclick: doWrite
			}));
		}

		var warnings = [];
		if (parsed.missing.length) {
			warnings.push('no show matched ' + parsed.missing.join(', '));
		}
		if (parsed.dropped) {
			warnings.push(parsed.dropped + ' line(s) pointed past the end of a show — ' +
				'reload your shows if you have listened to some since shuffling');
		}
		say(warnings.length ? 'Heads up: ' + warnings.join('; ') + '.' : '');
	}

	function chosenPlaylist() {
		var value = ui.dest.value;
		return playlists.filter(function (p) { return p.uuid === value; })[0] || null;
	}

	function doWritePlaylist(playlist, keepExisting) {
		var wanted = resolved.slice();

		say('Reading "' + playlist.title + '"…');

		readPlaylist(playlist.uuid).then(function (current) {
			if (!current) throw new Error('That playlist has gone.');

			try {
				localStorage.setItem(PL_BACKUP, JSON.stringify({
					at: Date.now(),
					uuid: current.uuid,
					title: current.title,
					episodes: current.episodes || [],
					episodeOrder: current.episodeOrder || []
				}));
			} catch (e) { /* best effort */ }
			renderUndo();

			var body = playlistWith(current, wanted, keepExisting);
			var last = body.episodeOrder[body.episodeOrder.length - 1];

			say((keepExisting ? 'Adding ' : 'Replacing with ') + wanted.length + ' episodes…');
			return putPlaylist(body, last).then(function () {
				return readPlaylist(playlist.uuid);
			}).then(function (after) {
				var have = {};
				((after && after.episodeOrder) || []).forEach(function (u) { have[u] = true; });
				var missing = wanted.filter(function (e) { return !have[e.uuid]; });

				if (!missing.length) {
					say(wanted.length + ' episodes now in "' + playlist.title + '".', 'ok');
					playlists = playlists.map(function (p) {
						return p.uuid === after.uuid ? after : p;
					});
					return;
				}
				return addOneByOne(playlist, wanted);
			});
		}).catch(function (e) {
			say(e.message, 'error');
		});
	}

	// Same route the player takes: one PUT per episode, each carrying the
	// playlist as it should look after that episode is added.
	function addOneByOne(playlist, episodes) {
		say('Bulk write did not take. Adding one at a time…');

		return readPlaylist(playlist.uuid).then(function (current) {
			return episodes.reduce(function (chain, episode, i) {
				return chain.then(function (state) {
					say('Adding ' + (i + 1) + ' of ' + episodes.length + '…');
					var body = playlistWith(state, [episode], true);
					return putPlaylist(body, episode.uuid).then(function () {
						return body;
					});
				});
			}, Promise.resolve(current));
		}).then(function () {
			say('Added ' + episodes.length + ' episodes to "' + playlist.title + '".', 'ok');
		});
	}

	function doWrite() {
		var wanted = resolved.slice();
		say('Backing up your current queue…');

		readUpNext().then(function (current) {
			var existing = (current.episodes || []).map(bare);
			stash(existing);
			renderUndo();

			say('Backed up ' + existing.length + ' episodes. Replacing…');
			return syncReplace(wanted).then(readUpNext);
		}).then(function (after) {
			if (queueMatches(after.episodes || [], wanted)) {
				say('Up Next now holds ' + wanted.length + ' episodes. Reload to see it.', 'ok');
				return;
			}
			offerAppend(wanted);
		}).catch(function (e) {
			say(e.message, 'error');
			offerAppend(wanted);
		});
	}

	// The one-shot replace is the apps' route, not the web player's, so it
	// may not be honoured. Appending one at a time definitely is.
	function offerAppend(wanted) {
		say('Could not replace the queue in one go. You can clear Up Next yourself ' +
			'in the player, then append these in order instead.', 'error');

		ui.preview.appendChild(el('button', {
			class: 'act warn',
			text: 'Append ' + wanted.length + ' episodes one by one',
			onclick: function (ev) {
				ev.target.disabled = true;
				appendEach(wanted, function (done, total) {
					say('Adding ' + done + ' of ' + total + '…');
				}).then(function () {
					say('Added ' + wanted.length + ' episodes. Reload to see them.', 'ok');
				}).catch(function (e) {
					say(e.message, 'error');
				});
			}
		}));
	}

	// pocketcasts.com serves the marketing site as well as the player, and the
	// player's paths cannot be enumerated reliably -- signed out, /podcasts
	// bounces to /user/login while /upnext and /files simply 404. So rather
	// than guess at paths, wait for the thing we actually need: a token. It
	// only ever turns up once the player has authenticated, which is exactly
	// when this script has something to offer.
	function haveToken() {
		if (!token) token = tokenFromStorage();
		return !!token;
	}

	function start() {
		if (haveToken()) return build();

		var waited = 0;
		var timer = setInterval(function () {
			waited += 500;
			if (haveToken()) {
				clearInterval(timer);
				build();
			} else if (waited >= 30000) {
				clearInterval(timer); // not a signed-in player page
			}
		}, 500);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start);
	} else {
		start();
	}
})();
