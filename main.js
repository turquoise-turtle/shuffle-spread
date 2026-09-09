'use strict';

var STORE = 'shuffle-spread.shows';
var LIMITS = 'shuffle-spread.limits';
var GOLDEN = 137.508;

// Each show is {uuid, title, count}. `uuid` is only set on rows imported from
// the Pocket Casts web player; manual rows fall back to a slug of the title, so
// either kind round-trips through the userscript.
var shows = [];

function slug(title) {
	return title.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'show';
}

// What the userscript matches on.
function keyOf(show) {
	return show.uuid || slug(show.title);
}

function hue(i) {
	return Math.round(i * GOLDEN) % 360;
}

/*
 * Spread shuffle.
 *
 * Every show is laid out along the same 0..1 line, so a show with 4 episodes
 * left gets the same total span as one with 40 -- it just has bigger gaps.
 * Sorting all the episodes by that position interleaves them proportionally.
 *
 * `phase` shifts a whole show along the line and the jitter nudges individual
 * episodes, so repeat shuffles differ without ever clumping a show together.
 * With randomise off both are zero, which gives a plain even interleave.
 *
 * Inspiration from https://keyj.emphy.de/balanced-shuffle/
 */
function spreadShuffle(list, randomise, perShow, total) {
	var items = [];

	list.forEach(function (show, order) {
		// Per-show cap first, so an enormous backlog cannot crowd out the
		// smaller shows before the total cap even gets a look in.
		var n = perShow ? Math.min(show.count, perShow) : show.count;
		if (!(n > 0)) return;

		var phase = randomise ? Math.random() : 0;

		for (var i = 0; i < n; i++) {
			var pos = (i + phase) / n;
			if (randomise) {
				// up to +/-15% of this show's gap, so episodes stay in order
				pos += (Math.random() - 0.5) * 0.3 / n;
			}
			items.push({ show: show, order: order, index: i + 1, pos: pos });
		}
	});

	items.sort(function (a, b) {
		return a.pos - b.pos || a.order - b.order || a.index - b.index;
	});

	// Truncating is safe: each show's episodes only ever move forwards along
	// the line, so any prefix holds episodes 1..j of a show with no gaps.
	return total ? items.slice(0, total) : items;
}

/* ---------- state ---------- */

function save() {
	try {
		localStorage.setItem(STORE, JSON.stringify(shows));
	} catch (e) {
		// private browsing, storage full -- the page still works, just forgets
	}
}

function load() {
	try {
		var raw = localStorage.getItem(STORE);
		if (raw) shows = JSON.parse(raw);
	} catch (e) {
		shows = [];
	}
	if (!Array.isArray(shows)) shows = [];
}

// The userscript hands over a list as #shows=<url-encoded JSON>, so the two
// pieces can be used together without either depending on the other.
function importFromHash() {
	var m = /[#&]shows=([^&]+)/.exec(location.hash);
	if (!m) return false;

	try {
		var incoming = JSON.parse(decodeURIComponent(m[1]));
		if (!Array.isArray(incoming) || !incoming.length) return false;

		shows = incoming.map(function (s) {
			return {
				uuid: s.k ? String(s.k) : '',
				title: String(s.t || ''),
				count: Math.max(0, parseInt(s.n, 10) || 0)
			};
		});
	} catch (e) {
		return false;
	}

	history.replaceState(null, '', location.pathname + location.search);
	return true;
}

/* ---------- input table ---------- */

var tbody = document.querySelector('#shows tbody');

function addRow(show) {
	if (!show) show = { uuid: '', title: '', count: null };
	shows.push(show);
	renderInput();
	var last = tbody.querySelector('tr:last-child input[type=text]');
	if (last) last.focus();
}

function renderInput() {
	tbody.textContent = '';

	shows.forEach(function (show, i) {
		var tr = document.createElement('tr');
		tr.style.setProperty('--h', hue(i));

		var tdName = document.createElement('td');
		tdName.className = 'has-dot';
		var dot = document.createElement('span');
		dot.className = 'dot';
		var name = document.createElement('input');
		name.type = 'text';
		name.placeholder = 'Show name';
		name.value = show.title;
		name.addEventListener('input', function () {
			show.title = name.value;
			save();
		});
		tdName.append(dot, name);

		var tdCount = document.createElement('td');
		var count = document.createElement('input');
		count.type = 'number';
		count.min = '0';
		count.placeholder = '0';
		count.value = show.count == null ? '' : show.count;
		count.addEventListener('input', function () {
			show.count = Math.max(0, parseInt(count.value, 10) || 0);
			save();
		});
		tdCount.appendChild(count);

		var tdDel = document.createElement('td');
		var del = document.createElement('button');
		del.type = 'button';
		del.className = 'del';
		del.title = 'Remove ' + (show.title || 'show');
		del.textContent = '×';
		del.addEventListener('click', function () {
			shows.splice(i, 1);
			save();
			renderInput();
		});
		tdDel.appendChild(del);

		tr.append(tdName, tdCount, tdDel);
		tbody.appendChild(tr);
	});

	if (!shows.length) addRow();
}

/* ---------- output ---------- */

var output = document.querySelector('#output');
var result = document.querySelector('#result');
var lastOrder = [];

function renderOutput(items, available) {
	lastOrder = items;
	result.textContent = '';

	items.forEach(function (item) {
		var li = document.createElement('li');
		li.style.setProperty('--h', hue(item.order));

		var title = document.createElement('span');
		title.className = 'title';
		title.textContent = item.show.title || keyOf(item.show);

		li.append(title, ' · #' + item.index);
		result.appendChild(li);
	});

	document.querySelector('#count').textContent = !items.length ? ''
		: available && available > items.length
			? '(' + items.length + ' of ' + available + ' left)'
			: '(' + items.length + ' episodes)';
	output.hidden = !items.length;
}

// Tab-separated so the userscript can parse it, readable enough to eyeball.
function asText() {
	return lastOrder.map(function (item) {
		return [keyOf(item.show), item.index, item.show.title].join('\t');
	}).join('\n');
}

/* ---------- wiring ---------- */

document.querySelector('#add').addEventListener('click', function () {
	addRow();
});

document.querySelector('#clear').addEventListener('click', function () {
	shows = [];
	save();
	renderInput();
	renderOutput([]);
});

function limit(sel) {
	var value = parseInt(document.querySelector(sel).value, 10);
	return value > 0 ? value : 0;
}

function saveLimits() {
	try {
		localStorage.setItem(LIMITS, JSON.stringify({
			perShow: document.querySelector('#per-show').value,
			total: document.querySelector('#total').value,
			randomise: document.querySelector('#randomise').checked
		}));
	} catch (e) { /* best effort */ }
}

function loadLimits() {
	try {
		var saved = JSON.parse(localStorage.getItem(LIMITS) || '{}');
		if (saved.perShow) document.querySelector('#per-show').value = saved.perShow;
		if (saved.total) document.querySelector('#total').value = saved.total;
		if (saved.randomise === false) document.querySelector('#randomise').checked = false;
	} catch (e) { /* defaults are fine */ }
}

['#per-show', '#total', '#randomise'].forEach(function (sel) {
	document.querySelector(sel).addEventListener('change', saveLimits);
});

document.querySelector('#shuffle').addEventListener('click', function () {
	var usable = shows.filter(function (s) { return s.count > 0; });
	var available = usable.reduce(function (n, s) { return n + s.count; }, 0);

	renderOutput(spreadShuffle(
		usable,
		document.querySelector('#randomise').checked,
		limit('#per-show'),
		limit('#total')
	), available);

	output.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

document.querySelector('#copy').addEventListener('click', function () {
	var note = document.querySelector('#copied');
	navigator.clipboard.writeText(asText()).then(function () {
		note.hidden = false;
		setTimeout(function () { note.hidden = true; }, 1500);
	});
});

// Enter anywhere in the table shuffles rather than doing nothing.
document.querySelector('#shows').addEventListener('keydown', function (e) {
	if (e.key === 'Enter') {
		e.preventDefault();
		document.querySelector('#shuffle').click();
	}
});

if (!importFromHash()) load();
loadLimits();
renderInput();
