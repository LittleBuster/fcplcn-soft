/** @file Relay action results to the host toast without moving the PLC form. */
const noticeIds = [
  'notice',
  'hardware-action-notice',
  'sockets-notice',
  'lights-notice',
  'meteo-notice',
  'thermostats-notice',
  'security-notice',
  'tanks-notice',
  'irrigation-notice',
  'firmware-notice',
  'config-backup-notice',
];

/** Keep field errors and resource conflicts inline; relay only explicit action messages. */
export function connectPLCNotices() {
  if (window.parent === window) return;
  const sources = noticeIds.map((id) => document.getElementById(id)).filter(Boolean);
  const previous = new Map();
  let active = null;
  let sequence = 0;
  let connected = false;

  const send = (notice) =>
    window.parent.postMessage(
      { type: 'fcplcn:plc-notice', version: 1, sequence: ++sequence, notice },
      window.location.origin,
    );
  const visible = (element) => !element.closest('[hidden]');
  const update = () => {
    let next = null;
    for (const element of sources) {
      const text = element.textContent.trim().slice(0, 4096);
      const tone = element.classList.contains('error')
        ? 'error'
        : element.classList.contains('success')
          ? 'success'
          : 'warning';
      const key = element.hidden || !text ? '' : JSON.stringify([tone, text]);
      const changed = previous.get(element) !== key;
      previous.set(element, key);
      // Remember hidden-page text too: returning to a tab must not replay an old result.
      if (changed && key && visible(element)) next = { element, key, notice: { tone, text } };
    }
    if (next) {
      active = next;
      send(next.notice);
    } else if (
      active &&
      (previous.get(active.element) !== active.key || !visible(active.element))
    ) {
      active = null;
      send(null);
    }
  };
  const observer = new MutationObserver(update);
  const enable = (event) => {
    if (
      connected ||
      event.origin !== window.location.origin ||
      event.source !== window.parent ||
      event.data?.type !== 'fcplcn:plc-notice-enable' ||
      event.data.version !== 1
    )
      return;
    connected = true;
    for (const element of sources) element.dataset.fcplcnActionNotice = '';
    document.documentElement.dataset.fcplcnNoticeRelay = 'true';
    update();
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['hidden', 'class'],
    });
  };
  window.addEventListener('message', enable);
  window.addEventListener('pagehide', () => {
    observer.disconnect();
    window.removeEventListener('message', enable);
  });
  // Older host tabs retain the inline messages until they support this handshake.
  window.parent.postMessage(
    { type: 'fcplcn:plc-notice-ready', version: 1 },
    window.location.origin,
  );
}
