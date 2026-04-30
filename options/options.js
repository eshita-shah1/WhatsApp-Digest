const apiKeyEl = document.getElementById('apiKey');
const mockEl = document.getElementById('mockMode');
const llamaEl = document.getElementById('llamaEndpoint');
const modelEl = document.getElementById('llamaModel');
const testBtn = document.getElementById('testKey');
const testResult = document.getElementById('testResult');
const persistEl = document.getElementById('storePersist');
const ephEl = document.getElementById('storeEphemeral');
const saveBtn = document.getElementById('save');
const clearBtn = document.getElementById('clear');

async function loadSettings() {
  const data = await chrome.storage.local.get(['apiKey', 'storeMode']);
  if (data.apiKey) apiKeyEl.value = data.apiKey;
  const more = await chrome.storage.local.get(['mockMode']);
  if (more.mockMode) mockEl.checked = true;
  const endpoint = (await chrome.storage.local.get(['llamaEndpoint'])).llamaEndpoint;
  if (endpoint) llamaEl.value = endpoint;
  const model = (await chrome.storage.local.get(['llamaModel'])).llamaModel;
  if (model) modelEl.value = model;
  else modelEl.value = 'llama-3.3-70b-versatile';
  if (data.storeMode === 'ephemeral') {
    ephEl.checked = true;
  } else {
    persistEl.checked = true;
  }
}

saveBtn.addEventListener('click', async () => {
  const key = apiKeyEl.value.trim();
  const mode = ephEl.checked ? 'ephemeral' : 'persist';
  const mock = mockEl.checked;
  if (mock) {
    // mock mode: don't require or persist API key
    await chrome.storage.local.set({ mockMode: true });
    await chrome.storage.local.remove('apiKey');
    await chrome.storage.local.set({ storeMode: 'mock' });
    chrome.runtime.sendMessage({ type: 'setEphemeralKey', key: null });
  } else {
    await chrome.storage.local.set({ mockMode: false });
    const endpoint = llamaEl.value.trim();
    const modelVal = modelEl.value.trim();
    if (endpoint) await chrome.storage.local.set({ llamaEndpoint: endpoint });
    else await chrome.storage.local.remove('llamaEndpoint');
    if (modelVal) await chrome.storage.local.set({ llamaModel: modelVal });
    else await chrome.storage.local.remove('llamaModel');
    if (mode === 'persist') {
      await chrome.storage.local.set({ apiKey: key, storeMode: 'persist' });
      chrome.runtime.sendMessage({ type: 'setEphemeralKey', key: null });
    } else {
      await chrome.storage.local.remove('apiKey');
      await chrome.storage.local.set({ storeMode: 'ephemeral' });
      chrome.runtime.sendMessage({ type: 'setEphemeralKey', key });
    }
  }
  alert('Saved');
});

clearBtn.addEventListener('click', async () => {
  apiKeyEl.value = '';
  await chrome.storage.local.remove(['apiKey', 'storeMode', 'mockMode', 'llamaEndpoint', 'llamaModel']);
  chrome.runtime.sendMessage({ type: 'setEphemeralKey', key: null });
  mockEl.checked = false;
  alert('Cleared');
});

loadSettings();

testBtn.addEventListener('click', async () => {
  testBtn.disabled = true;
  testResult.textContent = 'Testing...';
  const key = apiKeyEl.value.trim();
  const endpoint = llamaEl.value.trim();
  const model = modelEl.value.trim();
  const mock = mockEl.checked;
  try {
    const resp = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'testKey', apiKey: key, llamaEndpoint: endpoint, llamaModel: model, mockMode: mock }, (response) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        resolve(response);
      });
    });
    if (resp && resp.ok) {
      testResult.style.color = 'green';
      testResult.textContent = `OK: ${resp.message || 'Connection successful'}`;
    } else {
      testResult.style.color = 'crimson';
      testResult.textContent = `Error: ${resp && resp.message ? resp.message : 'Unknown error'}`;
    }
  } catch (e) {
    testResult.style.color = 'crimson';
    testResult.textContent = `Error: ${String(e)}`;
  } finally {
    testBtn.disabled = false;
    setTimeout(() => { testResult.textContent = ''; }, 7000);
  }
});
