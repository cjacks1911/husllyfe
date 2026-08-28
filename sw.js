/**
 * HUSLLYFE service worker.
 *
 * The app was always local-first: every score is computed in the browser from
 * data that never leaves it. This just lets the browser treat it that way —
 * installable on a home screen, and fully usable at a gym or under a car with
 * no signal, which is exactly where logging actually happens.
 *
 * Two strategies, chosen for different failure modes:
 *
 *   HTML  network-first, cache as fallback. A page must never be served from
 *         a stale cache after a deploy — that is the classic service-worker
 *         bug where users are pinned to an old build until they clear data.
 *         Online you always get the newest page; offline you get the last one.
 *
 *   CSS / JS / icons  cache-first, refreshed in the background. These load
 *         instantly and quietly update for the next visit. Paired with the
 *         network-first HTML above, a deploy lands within one reload.
 *
 * Cross-origin is split by what the request is for, not where it comes from:
 *
 *   images  cached, in their own bucket. The site pulls 17 photographs from
 *           Unsplash; without this every hero panel is a grey hole the moment
 *           you lose signal, which looks broken rather than offline.
 *
 *   anything else  straight to the network, never stored. That is the NHTSA
 *           rule: a recall answer served silently from last month's cache
 *           would be worse than no answer at all, and the app already stamps
 *           every lookup with the date it was fetched.
 *
 * The image bucket is versioned separately so a code deploy does not throw
 * away megabytes of photographs that have not changed.
 *
 * Bump CACHE_VERSION on any deploy that changes an asset.
 */
var CACHE_VERSION  = 'husllyfe-v2';
var IMG_CACHE      = 'husllyfe-img-v1';
var REMINDER_CACHE = 'husllyfe-reminders';
var IMG_MAX       = 40;

var SHELL = [
  'index.html', 'body.html', 'strength.html', 'wealth.html',
  'drive.html', 'garage.html', 'how-it-works.html',
  'app.css', 'app.js', 'body.css', 'strength.css', 'garage.css',
  'wealth.css', 'how-it-works.css',
  'logo.png', 'favicon.png', 'favicon.ico', 'apple-touch-icon.png',
  'icon-512.png', 'icon-maskable-512.png', 'manifest.json',
  'privacy.html'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      // addAll is all-or-nothing: one 404 would abandon the whole install, so
      // each file is added on its own and a missing one is simply skipped.
      return Promise.all(SHELL.map(function (url) {
        return cache.add(new Request(url, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        // The reminder cache is data, not a copy of the site. Sweeping it on
        // a version bump would forget which reminders had already been shown
        // and re-fire every one of them after the next deploy.
        if (k === CACHE_VERSION || k === IMG_CACHE || k === REMINDER_CACHE) return null;
        return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

/**
 * Cache-first for an off-origin image, with the bucket trimmed to IMG_MAX.
 *
 * `res.ok` is false for a no-cors image response — status is forced to 0 and
 * the body is opaque — so opaque responses are stored explicitly. That is the
 * only way to cache an <img> from another origin, and it is safe here because
 * an opaque response is never read by script, only painted.
 */
function cacheImage(req) {
  return caches.open(IMG_CACHE).then(function (cache) {
    return cache.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) {
          cache.put(req, res.clone());
          trim(cache);
        }
        return res;
      });
    });
  });
}

function trim(cache) {
  cache.keys().then(function (keys) {
    // keys() returns insertion order, so the front of the list is the oldest.
    for (var i = 0; i < keys.length - IMG_MAX; i++) cache.delete(keys[i]);
  });
}

/* =====================================================================
 * Reminders
 *
 * The page computes what is due and mirrors a small digest into the cache
 * below, because a service worker cannot read localStorage and therefore
 * cannot recompute any of it. Everything here is date arithmetic on that
 * digest — no scoring logic lives in this file, so there is nothing to
 * drift out of agreement with app.js.
 *
 * Two ways in:
 *   periodicsync   the browser waking us on its own schedule. Chromium,
 *                  installed apps, best-effort, and allowed to never fire.
 *   message        the page asking for the same check immediately, which is
 *                  what the "send a test" button uses, so the test exercises
 *                  the real path rather than a parallel copy of it.
 * ===================================================================== */
var DIGEST_URL     = '__husllyfe_reminders';
var NOTIFIED_URL   = '__husllyfe_notified';
var SYNC_TAG       = 'husllyfe-due-check';

// How long before the same item is allowed to speak again. An overdue
// service nags weekly; "due soon" says it once a fortnight and then shuts up.
// Without this the first background wake after a week away would fire one
// notification per item and read as spam.
var RENOTIFY_DAYS = { overdue: 7, soon: 14 };

function readJson(url, fallback) {
  return caches.open(REMINDER_CACHE)
    .then(function (c) { return c.match(url); })
    .then(function (r) { return r ? r.json() : fallback; })
    .catch(function () { return fallback; });
}

function writeJson(url, obj) {
  return caches.open(REMINDER_CACHE).then(function (c) {
    return c.put(url, new Response(JSON.stringify(obj),
      { headers: { 'Content-Type': 'application/json' } }));
  }).catch(function () {});
}

function pad(n) { return (n < 10 ? '0' : '') + n; }
function todayKey() {
  var d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function daysSince(ymd) {
  if (!ymd) return Infinity;
  var p = String(ymd).split('-');
  var then = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  var ms = Date.now() - then.getTime();
  return isNaN(ms) ? Infinity : Math.floor(ms / 86400000);
}

function setBadge(n) {
  try {
    if (n > 0 && self.navigator && self.navigator.setAppBadge) {
      var p = self.navigator.setAppBadge(n);
      if (p && p.catch) p.catch(function () {});
    } else if (self.navigator && self.navigator.clearAppBadge) {
      var q = self.navigator.clearAppBadge();
      if (q && q.catch) q.catch(function () {});
    }
  } catch (e) {}
}

/**
 * One notification for the whole digest rather than one per item. Six
 * separate notifications for six overdue services is how an app gets its
 * notifications switched off permanently.
 */
function showDigest(items) {
  var title, body;
  if (items.length === 1) {
    title = items[0].status === 'overdue' ? 'Service overdue' : 'Service due soon';
    body = items[0].title + '\n' + items[0].detail;
  } else {
    var over = items.filter(function (i) { return i.status === 'overdue'; }).length;
    title = over ? over + ' overdue on your fleet' : items.length + ' services due soon';
    body = items.slice(0, 3).map(function (i) { return '• ' + i.title; }).join('\n');
    if (items.length > 3) body += '\n…and ' + (items.length - 3) + ' more';
  }
  return self.registration.showNotification(title, {
    body: body,
    tag: 'husllyfe-due',
    renotify: true,
    icon: 'icon-512.png',
    badge: 'favicon.png',
    data: { url: 'garage.html' }
  });
}

function runDueCheck(force) {
  return Promise.all([readJson(DIGEST_URL, null), readJson(NOTIFIED_URL, {})])
    .then(function (r) {
      var digest = r[0], notified = r[1] || {};
      var items = (digest && digest.items) || [];
      setBadge(items.filter(function (i) { return i.status === 'overdue'; }).length);
      if (!items.length) return;

      var speak = force ? items : items.filter(function (i) {
        return daysSince(notified[i.key]) >= (RENOTIFY_DAYS[i.status] || 14);
      });
      if (!speak.length) return;

      var today = todayKey();
      speak.forEach(function (i) { notified[i.key] = today; });
      // Record BEFORE showing. If showNotification throws, having said it
      // once too few is better than a loop that re-fires every wake.
      return writeJson(NOTIFIED_URL, notified).then(function () {
        return showDigest(speak);
      });
    })
    .catch(function () {});
}

self.addEventListener('periodicsync', function (e) {
  if (e.tag !== SYNC_TAG) return;
  e.waitUntil(runDueCheck(false));
});

self.addEventListener('message', function (e) {
  var d = e.data || {};
  if (d.type === 'husllyfe-check') {
    e.waitUntil(runDueCheck(!!d.force));
  }
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var target = (e.notification.data && e.notification.data.url) || 'garage.html';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (list) {
        // Reuse a window that is already open rather than stacking up
        // duplicates of the app every time a reminder is tapped.
        for (var i = 0; i < list.length; i++) {
          if (list[i].url.indexOf(self.location.origin) === 0 && 'focus' in list[i]) {
            if ('navigate' in list[i]) list[i].navigate(target).catch(function () {});
            return list[i].focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(target);
      })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  // The reminder digest is cache-only bookkeeping, never a real request.
  if (req.url.indexOf('__husllyfe_') > -1) return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }

  if (url.origin !== self.location.origin) {
    // Photographs are worth keeping so the site still looks like itself with
    // no signal. Everything else off-origin — the NHTSA VIN and recall calls —
    // is left alone, so it either answers live or does not answer.
    if (req.destination === 'image') e.respondWith(cacheImage(req));
    return;
  }

  var isHTML = req.mode === 'navigate' ||
               (req.headers.get('accept') || '').indexOf('text/html') > -1;

  if (isHTML) {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE_VERSION).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match('index.html');
        });
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(function (hit) {
      var live = fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE_VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || live;
    })
  );
});
