// ==UserScript==
// @name         Pocket Casts — bulk archive by title
// @namespace    https://github.com/turquoise-turtle/shuffle-spread
// @version      0.1.0
// @description  Archive every episode of one show whose title matches a numbered prefix, for when a feed reset wiped your play state
// @author       turquoise-turtle
// @homepageURL  https://github.com/turquoise-turtle/shuffle-spread
// @supportURL   https://github.com/turquoise-turtle/shuffle-spread/issues
// @downloadURL  https://raw.githubusercontent.com/turquoise-turtle/shuffle-spread/master/pocketcasts-archive.user.js
// @updateURL    https://raw.githubusercontent.com/turquoise-turtle/shuffle-spread/master/pocketcasts-archive.user.js
// @match        https://pocketcasts.com/*
// @match        https://play.pocketcasts.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
	'use strict';

	var API = 'https://api.pocketcasts.com';
	var CACHE = 'https://cache.pocketcasts.com';
	var LAST = 'spread-shuffle.archive-last';

	var BATCH = 25; // the capture only ever sent one; keep requests small

	/* ---------------------------------------------------------------
	 * Auth
	 *
	 * Same trick as the shuffle userscript: the player is already signed
	 * in, so watch its own requests go past and lift the bearer token off
	 * them. Duplicated rather than shared because there is no build step
	 * and each userscript has to stand alone.
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
			}).filter(function (p) {
				return p.uuid;
			}).sort(function (a, b) {
				return a.title.localeCompare(b.title);
			});
		});
	}

	// The public feed, newest first. Only the title and uuid matter here.
	function loadFeed(podcastUuid) {
		return fetch(CACHE + '/mobile/podcast/full/' + podcastUuid).then(function (r) {
			if (!r.ok) throw new Error('Could not read the episode list (HTTP ' + r.status + ')');
			return r.json();
		}).then(function (data) {
			var show = data.podcast || {};
			if (show.has_more_episodes) {
				// Newest first, so a truncated feed hides the oldest episodes --
				// exactly the ones a numbered back catalogue starts with.
				throw new Error('That feed came back partial (has_more_episodes), so the ' +
					'oldest episodes are missing. Archiving from it would silently skip them.');
			}
			return (show.episodes || []).map(function (ep) {
				return { uuid: ep.uuid, title: ep.title || '', published: ep.published || '' };
			});
		});
	}

	// Play state for the episodes you have touched, so already-archived ones
	// can be left alone instead of written again.
	function loadState(podcastUuid) {
		return api('/user/podcast/episodes/bookmarks', { uuid: podcastUuid })
			.then(function (data) {
				var state = {};
				(data.episodes || []).forEach(function (e) { state[e.uuid] = e; });
				return state;
			});
	}

	function setArchived(episodes, podcastUuid, archived) {
		return api('/sync/update_episodes_archive', {
			episodes: episodes.map(function (e) {
				return { uuid: e.uuid, podcast: podcastUuid };
			}),
			archive: !!archived
		});
	}

	/* ---------------------------------------------------------------
	 * Rules
	 *
	 * One per line: "<prefix>" or "<prefix> <from>-<to>". The prefix is
	 * letters, and the number that follows it in the title is always three
	 * digits -- "MATT001 - Two Things That Are True About the Bible".
	 * ------------------------------------------------------------- */

	function parseRules(text) {
		var rules = [];
		var bad = [];

		String(text || '').split('\n').forEach(function (line) {
			line = line.trim();
			if (!line || line.charAt(0) === '#') return;

			var m = /^([A-Za-z]+)(?:\s+(\d{1,3})\s*-\s*(\d{1,3}))?$/.exec(line);
			if (!m) {
				bad.push(line);
				return;
			}
			rules.push({
				prefix: m[1].toUpperCase(),
				from: m[2] === undefined ? 0 : parseInt(m[2], 10),
				to: m[3] === undefined ? 999 : parseInt(m[3], 10),
				source: line
			});
		});

		return { rules: rules, bad: bad };
	}

	// The prefix is letters only, so it needs no regex escaping.
	function ruleMatches(title, rule) {
		var m = new RegExp('^' + rule.prefix + '(\\d{3})\\s*-\\s*\\S').exec(String(title).trim());
		if (!m) return false;
		var n = parseInt(m[1], 10);
		return n >= rule.from && n <= rule.to;
	}

	function selectEpisodes(episodes, rules) {
		var hits = [];
		var perRule = {};
		rules.forEach(function (r) { perRule[r.source] = 0; });

		episodes.forEach(function (ep) {
			for (var i = 0; i < rules.length; i++) {
				if (ruleMatches(ep.title, rules[i])) {
					perRule[rules[i].source]++;
					hits.push(ep);
					return; // one episode counts once, however many rules cover it
				}
			}
		});

		return { hits: hits, perRule: perRule };
	}

	/* ---------------------------------------------------------------
	 * State
	 * ------------------------------------------------------------- */

	var podcasts = [];
	var matched = [];   // episodes the rules picked out
	var pending = [];   // of those, the ones not already archived

	function rememberLast(podcastUuid, episodes) {
		try {
			localStorage.setItem(LAST, JSON.stringify({
				at: Date.now(),
				podcast: podcastUuid,
				episodes: episodes.map(function (e) {
					return { uuid: e.uuid, title: e.title };
				})
			}));
		} catch (e) { /* best effort */ }
	}

	function readLast() {
		try {
			var raw = localStorage.getItem(LAST);
			return raw ? JSON.parse(raw) : null;
		} catch (e) {
			return null;
		}
	}

	/* ---------------------------------------------------------------
	 * UI
	 * ------------------------------------------------------------- */

	var ui = {};

	var CSS = [
		':host{all:initial}',
		'*{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}',
		'.launch{position:fixed;right:18px;bottom:64px;z-index:2147483646;padding:10px 14px;',
		'border:0;border-radius:999px;background:#3a3a42;color:#fff;font-size:13px;font-weight:600;',
		'cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35)}',
		'.panel{position:fixed;right:18px;bottom:116px;z-index:2147483647;width:380px;max-height:76vh;',
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
		'select,textarea{width:100%;padding:6px 8px;margin:0 0 6px;border:1px solid #3a3a42;',
		'border-radius:6px;background:#26262c;color:#eee;font-size:12px}',
		'textarea{height:64px;background:#111114;color:#ddd;',
		'font:12px/1.5 ui-monospace,Menlo,monospace;resize:vertical}',
		'ol{margin:0;padding-left:26px;max-height:200px;overflow-y:auto}',
		'ol li{padding:2px 0;color:#b8b8c0}',
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
			el('span', { text: 'Bulk archive' }),
			el('button', { text: '×', title: 'Close', onclick: function () { panel.classList.remove('open'); } })
		]));

		var body = el('div', { class: 'body' });

		body.appendChild(el('h4', { text: '1 · Show' }));
		ui.podcast = el('select', {});
		ui.podcast.appendChild(el('option', { value: '', text: 'Load your subscriptions…' }));
		body.appendChild(ui.podcast);
		ui.loadBtn = el('button', { class: 'act', text: 'Load subscriptions', onclick: doLoadPodcasts });
		body.appendChild(ui.loadBtn);

		body.appendChild(el('h4', { text: '2 · Title rules' }));
		ui.rules = el('textarea', { spellcheck: 'false' });
		ui.rules.value = 'NEH\nMATT 001-200';
		body.appendChild(ui.rules);
		body.appendChild(el('p', {
			class: 'note',
			text: 'One per line: a letter prefix, optionally a range. "NEH" takes every ' +
				'NEH### episode; "MATT 001-200" only that span. Titles must read ' +
				'PREFIX### - something.'
		}));

		body.appendChild(el('button', { class: 'act', text: 'Preview matches', onclick: doPreview }));

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
			text: 'Bulk archive',
			onclick: function () {
				panel.classList.toggle('open');
				renderUndo();
			}
		}));

		renderUndo();
	}

	function renderUndo() {
		ui.undo.textContent = '';

		var last = readLast();
		if (!last || !(last.episodes || []).length) return;

		ui.undo.appendChild(el('h4', { text: 'Last run' }));
		ui.undo.appendChild(el('button', {
			class: 'act warn',
			text: 'Un-archive those ' + last.episodes.length,
			onclick: function () { doUndo(last); }
		}));
		ui.undo.appendChild(el('p', {
			class: 'note',
			text: 'Archived ' + new Date(last.at).toLocaleString() + '. Un-archiving sends ' +
				'the same call with archive:false, which has not been captured from the ' +
				'player — it is checked afterwards either way.'
		}));
	}

	function doLoadPodcasts() {
		ui.loadBtn.disabled = true;
		say('Loading your subscriptions…');

		loadPodcasts().then(function (list) {
			podcasts = list;
			ui.podcast.textContent = '';
			ui.podcast.appendChild(el('option', { value: '', text: 'Pick a show…' }));
			podcasts.forEach(function (p) {
				ui.podcast.appendChild(el('option', { value: p.uuid, text: p.title }));
			});
			say(podcasts.length + ' subscriptions. Pick the show to archive from.', 'ok');
		}).catch(function (e) {
			say(e.message, 'error');
		}).then(function () {
			ui.loadBtn.disabled = false;
		});
	}

	function chosenPodcast() {
		var value = ui.podcast.value;
		return podcasts.filter(function (p) { return p.uuid === value; })[0] || null;
	}

	function doPreview() {
		var podcast = chosenPodcast();
		if (!podcast) {
			say('Pick a show first.', 'error');
			return;
		}

		var parsed = parseRules(ui.rules.value);
		ui.preview.textContent = '';
		matched = [];
		pending = [];

		if (parsed.bad.length) {
			say('Could not read these rules: ' + parsed.bad.join(', '), 'error');
			return;
		}
		if (!parsed.rules.length) {
			say('No rules to apply.', 'error');
			return;
		}

		say('Reading "' + podcast.title + '"…');

		Promise.all([loadFeed(podcast.uuid), loadState(podcast.uuid)]).then(function (both) {
			var episodes = both[0];
			var state = both[1];

			var picked = selectEpisodes(episodes, parsed.rules);
			matched = picked.hits;
			pending = matched.filter(function (ep) {
				var s = state[ep.uuid];
				return !(s && s.isDeleted);
			});

			var counts = parsed.rules.map(function (r) {
				return r.source + ': ' + picked.perRule[r.source];
			}).join(' · ');

			if (!matched.length) {
				say('Nothing in "' + podcast.title + '" matched (' + counts + '). ' +
					'Checked ' + episodes.length + ' episodes — check the prefix ' +
					'against a real title.', 'error');
				return;
			}

			var list = el('ol');
			pending.slice(0, 200).forEach(function (ep) {
				list.appendChild(el('li', { text: ep.title }));
			});
			ui.preview.appendChild(list);

			if (pending.length > 200) {
				ui.preview.appendChild(el('p', {
					class: 'note',
					text: '…and ' + (pending.length - 200) + ' more.'
				}));
			}

			if (!pending.length) {
				say(matched.length + ' matched (' + counts + '), and every one is ' +
					'already archived. Nothing to do.', 'ok');
				return;
			}

			ui.preview.appendChild(el('button', {
				class: 'act go',
				text: 'Archive these ' + pending.length,
				onclick: function (ev) { doArchive(podcast, ev.target); }
			}));

			say(matched.length + ' matched (' + counts + ') out of ' + episodes.length +
				' episodes; ' + (matched.length - pending.length) + ' already archived.', 'ok');
		}).catch(function (e) {
			say(e.message, 'error');
		});
	}

	function inBatches(episodes, run, onProgress) {
		var batches = [];
		for (var i = 0; i < episodes.length; i += BATCH) {
			batches.push(episodes.slice(i, i + BATCH));
		}
		return batches.reduce(function (chain, batch, i) {
			return chain.then(function () {
				if (onProgress) onProgress(Math.min((i + 1) * BATCH, episodes.length), episodes.length);
				return run(batch);
			});
		}, Promise.resolve());
	}

	// The archive call answers with an empty object, so it tells us nothing.
	// The only way to know it worked is to read the play state back.
	function verify(podcastUuid, episodes, wantArchived) {
		return loadState(podcastUuid).then(function (state) {
			var wrong = episodes.filter(function (ep) {
				var s = state[ep.uuid];
				return !!(s && s.isDeleted) !== wantArchived;
			});
			return { wrong: wrong, done: episodes.length - wrong.length };
		});
	}

	function doArchive(podcast, button) {
		var wanted = pending.slice();
		if (button) button.disabled = true;

		say('Archiving 0 of ' + wanted.length + '…');

		inBatches(wanted, function (batch) {
			return setArchived(batch, podcast.uuid, true);
		}, function (done, total) {
			say('Archiving ' + done + ' of ' + total + '…');
		}).then(function () {
			say('Checking what actually landed…');
			return verify(podcast.uuid, wanted, true);
		}).then(function (result) {
			rememberLast(podcast.uuid, wanted.filter(function (ep) {
				return result.wrong.indexOf(ep) === -1;
			}));
			renderUndo();

			if (!result.wrong.length) {
				say('Archived ' + result.done + ' episodes in "' + podcast.title +
					'". Reload to see it.', 'ok');
			} else {
				say('Archived ' + result.done + ' of ' + wanted.length + '. ' +
					result.wrong.length + ' did not take — first is "' +
					result.wrong[0].title + '". Preview again to retry just those.', 'error');
			}
		}).catch(function (e) {
			say(e.message, 'error');
			if (button) button.disabled = false;
		});
	}

	function doUndo(last) {
		var wanted = last.episodes.slice();
		say('Un-archiving 0 of ' + wanted.length + '…');

		inBatches(wanted, function (batch) {
			return setArchived(batch, last.podcast, false);
		}, function (done, total) {
			say('Un-archiving ' + done + ' of ' + total + '…');
		}).then(function () {
			say('Checking what actually landed…');
			return verify(last.podcast, wanted, false);
		}).then(function (result) {
			if (!result.wrong.length) {
				say('Un-archived ' + result.done + ' episodes. Reload to see them.', 'ok');
				try {
					localStorage.removeItem(LAST);
				} catch (e) { /* best effort */ }
				renderUndo();
			} else {
				say('Un-archived ' + result.done + ' of ' + wanted.length + '. ' +
					result.wrong.length + ' stayed archived, so archive:false may not ' +
					'be a route the server honours. Un-archive the rest in the app.', 'error');
			}
		}).catch(function (e) {
			say(e.message, 'error');
		});
	}

	// Same reasoning as the shuffle userscript: this host serves the marketing
	// site too and the player's paths cannot be enumerated, so wait for a token
	// rather than guessing at URLs.
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
