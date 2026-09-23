// Consent gate logic. Capture stays off until the user accepts here.
// No em dashes in this file, per project rule.

const $ = id => document.getElementById(id);

$('agree').addEventListener('change', () => { $('accept').disabled = !$('agree').checked; });

$('accept').addEventListener('click', () => {
  chrome.storage.sync.set({ consentAccepted: true, consentAt: new Date().toISOString() }, () => {
    $('status').textContent = 'Accepted. Capture is enabled on the sites you turn on. You can close this tab.';
    $('accept').disabled = true;
  });
});

$('decline').addEventListener('click', () => {
  chrome.storage.sync.set({ consentAccepted: false }, () => {
    $('status').style.color = '#ff9d80';
    $('status').textContent = 'Declined. Capture stays off until you accept.';
  });
});
