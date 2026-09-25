// Consent gate logic. Capture stays off until the user accepts here.
// No em dashes in this file, per project rule.

const $ = id => document.getElementById(id);

$('agree').addEventListener('change', () => { $('accept').disabled = !$('agree').checked; });

$('accept').addEventListener('click', () => {
  // This click is a user gesture, the one place we are allowed to ask for the
  // all-sites permission, so all-websites capture works from the start without
  // a separate trip to the options page. If the user declines the browser
  // prompt, capture still runs on the chat sites and X.
  chrome.permissions.request({ origins: ['<all_urls>'] }, granted => {
    chrome.storage.sync.set({ consentAccepted: true, consentAt: new Date().toISOString(), allWebsites: !!granted }, () => {
      $('status').textContent = granted
        ? 'Accepted. Capture is on across all websites. You can close this tab.'
        : 'Accepted. Capture is on for chat sites and X. Turn on all-websites from the pill any time.';
      $('accept').disabled = true;
    });
  });
});

$('decline').addEventListener('click', () => {
  chrome.storage.sync.set({ consentAccepted: false }, () => {
    $('status').style.color = '#ff9d80';
    $('status').textContent = 'Declined. Capture stays off until you accept.';
  });
});
