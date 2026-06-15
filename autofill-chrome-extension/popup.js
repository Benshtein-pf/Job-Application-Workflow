const checkbox = document.getElementById('auto-redirect');

chrome.storage.local.get('auto-redirect', (data) => {
  checkbox.checked = !!data['auto-redirect'];
});

checkbox.addEventListener('change', () => {
  chrome.storage.local.set({ 'auto-redirect': checkbox.checked });
});

const fillBtn = document.getElementById('fill-now');

fillBtn.addEventListener('click', async () => {
  fillBtn.disabled = true;
  fillBtn.textContent = 'Filling...';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'job-autofill-run' });
    const skipped = response?.skipped || [];
    fillBtn.textContent = skipped.length ? `Done (${skipped.length} skipped)` : 'Done!';
  } catch (e) {
    fillBtn.textContent = 'Error — reload page';
  }
  setTimeout(() => {
    fillBtn.textContent = 'Autofill This Page';
    fillBtn.disabled = false;
  }, 2500);
});
