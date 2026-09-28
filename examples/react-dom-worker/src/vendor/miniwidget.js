/**
 * MiniWidget — a VENDORED "third-party" DOM library: plain JS, no deps,
 * unmodified. It is written exactly the way real widget libraries are:
 *
 *   - reaches for the GLOBAL `document` (installed by installDomShim)
 *   - builds its markup with `el.innerHTML = template`
 *   - delegates events through `document.addEventListener`
 *   - pokes `classList`, `dataset`, `textContent`, `querySelector`
 *
 * Inside an island realm every one of those calls lands on the worker-side
 * proxy DOM and emits ordinary ops — the library has no idea.
 */
var MiniWidget = (function () {
  var TEMPLATE =
    '<div class="mw-bar">' +
    '<span class="mw-label" data-role="label">miniwidget</span>' +
    '<button type="button" class="mw-btn" data-action="ping">ping</button>' +
    '<button type="button" class="mw-btn" data-action="clear">clear</button>' +
    '</div>' +
    '<ul class="mw-log" data-role="log"></ul>';

  var MAX_ENTRIES = 4;
  var mounted = null;
  var count = 0;

  function findLog() {
    return mounted ? mounted.querySelector('[data-role="log"]') : null;
  }

  // Delegated on the document — real libs do this so late-added markup works.
  function onClick(event) {
    var target = event.target;
    var btn = target && target.closest ? target.closest('[data-action]') : null;
    if (!btn || !mounted || !mounted.contains(btn)) return;
    var log = findLog();
    if (!log) return;
    var action = btn.dataset.action;
    if (action === 'ping') {
      count += 1;
      var li = document.createElement('li');
      li.className = 'mw-entry';
      li.dataset.n = String(count);
      li.textContent = 'ping #' + count;
      log.appendChild(li);
      while (log.children.length > MAX_ENTRIES) log.removeChild(log.firstChild);
    } else if (action === 'clear') {
      log.innerHTML = ''; // exercises the innerHTML setter — replace children
      count = 0;
    }
  }

  return {
    /** Mount the widget inside `root` — returns the host element. */
    mount: function (root) {
      var host = document.createElement('div');
      host.className = 'mini-widget';
      host.innerHTML = TEMPLATE;
      root.appendChild(host);
      mounted = host;
      count = 0;
      document.addEventListener('click', onClick);
      return host;
    },
    /** Remove the widget and its delegated listener. */
    unmount: function () {
      document.removeEventListener('click', onClick);
      if (mounted) mounted.remove();
      mounted = null;
    },
    /** Label setter — the consumer can restyle the widget. */
    setLabel: function (text) {
      var label = mounted && mounted.querySelector('[data-role="label"]');
      if (label) label.textContent = String(text);
    },
    get el() {
      return mounted;
    },
    get pings() {
      return count;
    },
  };
})();

export { MiniWidget };
