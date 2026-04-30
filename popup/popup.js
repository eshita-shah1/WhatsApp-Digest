function el(id){return document.getElementById(id)}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

async function requestMessages() {
  const tab = await getActiveTab();
  if (!tab) return { messages: [], error: 'no_tab' };

  // Check if we're on WhatsApp Web
  if (!tab.url || !tab.url.includes('web.whatsapp.com')) {
    return { messages: [], error: 'not_whatsapp' };
  }

  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'requestExtract' });
    return { messages: resp && resp.messages || [], error: null };
  } catch (e) {
    console.warn('[popup] First requestExtract failed:', e.message);
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content_script.js']
      });
      await new Promise(r => setTimeout(r, 800));
      const resp2 = await chrome.tabs.sendMessage(tab.id, { type: 'requestExtract' });
      return { messages: resp2 && resp2.messages || [], error: null };
    } catch (e2) {
      console.warn('[popup] Injection/retry failed:', e2.message);
      try {
        const resp3 = await chrome.tabs.sendMessage(tab.id, { type: 'getMessages' });
        return { messages: resp3 && resp3.messages || [], error: null };
      } catch (e3) {
        return { messages: [], error: 'content_script_failed' };
      }
    }
  }
}

function renderError(errorType) {
  const container = el('messages');
  const errorMessages = {
    'no_tab': '⚠️ No active tab found. Please open a tab.',
    'not_whatsapp': '⚠️ Please open <b>web.whatsapp.com</b> first, then click refresh.',
    'content_script_failed': '⚠️ Could not connect to WhatsApp Web. Try reloading the WhatsApp tab and clicking refresh.',
    'no_messages': '💬 No messages found. Make sure you have a chat open in WhatsApp Web.',
    'no_api_key': '🔑 No API key configured. Click ⚙️ to set up your Groq API key.',
    'categorize_failed': '⚠️ Categorization failed. Showing raw messages instead.'
  };
  container.innerHTML = `<div class="error-msg">${errorMessages[errorType] || errorType}</div>`;
}

function renderMessages(messages) {
  const container = el('messages');
  container.innerHTML = '';
  if (!messages || messages.length === 0) {
    renderError('no_messages');
    return;
  }
  messages.slice().reverse().forEach((m) => {
    const div = document.createElement('div');
    div.className = 'card';

    const cardTop = document.createElement('div');
    cardTop.className = 'card-top';

    const cardClickArea = document.createElement('div');
    cardClickArea.className = 'card-click-area';
    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = m.text.slice(0, 120) || '(no text)';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${m.sender || 'Unknown'} • ${m.timestamp || ''}`;
    cardClickArea.appendChild(title);
    cardClickArea.appendChild(meta);
    cardClickArea.addEventListener('click', async () => {
      await jumpToChat(div, m);
    });

    const arrow = document.createElement('button');
    arrow.className = 'expand-arrow';
    arrow.innerHTML = '&#9662;';
    arrow.title = 'Show full message';

    const expandBody = document.createElement('div');
    expandBody.className = 'expand-body';
    expandBody.textContent = m.text || '(no text)';

    arrow.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = div.classList.toggle('expanded');
      arrow.innerHTML = open ? '&#9652;' : '&#9662;';
    });

    cardTop.appendChild(cardClickArea);
    cardTop.appendChild(arrow);
    div.appendChild(cardTop);
    div.appendChild(expandBody);
    container.appendChild(div);
  });
}

// Current filter state
let currentFilter = null; // null = show all
let lastCategorizedData = null;
let lastMessages = null;

async function refresh() {
  el('refresh').disabled = true;
  el('lastUpdated').textContent = 'Last updated: refreshing...';
  const container = el('messages');
  const chipsContainer = el('categories');
  chipsContainer.innerHTML = '';
  container.innerHTML = '<div class="loading">⏳ Extracting messages...</div>';

  currentFilter = null;

  const { messages, error } = await requestMessages();

  if (error) {
    renderError(error);
    el('lastUpdated').textContent = `Last updated: failed`;
    el('refresh').disabled = false;
    return;
  }

  if (!messages || messages.length === 0) {
    renderError('no_messages');
    el('lastUpdated').textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
    el('refresh').disabled = false;
    return;
  }

  container.innerHTML = `<div class="loading">🤖 Analyzing ${messages.length} messages...</div>`;

  // Ask background to categorize
  try {
    const resp = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'categorizeMessages', messages }, (response) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        console.debug('[popup] categorizeMessages response', response);
        resolve(response);
      });
    });

    if (resp && resp.ok && resp.result) {
      lastMessages = messages;
      lastCategorizedData = normalizeCategorizedData(resp.result, messages);
      renderDynamicChips(lastCategorizedData);
      renderCategorized(lastCategorizedData, messages, null);
    } else {
      console.warn('[popup] Categorization response not ok:', resp);
      renderMessages(messages);
    }
  } catch (e) {
    console.error('[popup] Categorization error:', e);
    renderMessages(messages);
  }
  el('lastUpdated').textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
  el('refresh').disabled = false;
}

// Normalize the LLM response into a consistent format
// Handles both new format {categories, messages} and old format {1: {category, title, urgency}}
function normalizeCategorizedData(data, messages) {
  // New format: { categories: [...], messages: {...} }
  if (data.categories && data.messages) {
    return data;
  }

  // Old/flat format: { "1": {category, title, urgency}, "2": ... }
  // Convert to new format by extracting unique categories
  const catSet = new Map();
  const msgMap = {};

  Object.keys(data).forEach(k => {
    const item = data[k];
    if (item && item.category) {
      const cat = item.category;
      if (!catSet.has(cat)) {
        catSet.set(cat, pickEmoji(cat));
      }
      msgMap[k] = item;
    }
  });

  return {
    categories: Array.from(catSet.entries()).map(([name, emoji]) => ({ name, emoji })),
    messages: msgMap
  };
}

function pickEmoji(categoryName) {
  const lower = (categoryName || '').toLowerCase();
  const map = {
    housing: '🏠', room: '🏠', flat: '🏠', rent: '🏠', accommodation: '🏠', pg: '🏠',
    tech: '💻', hackathon: '💻', coding: '💻', development: '💻',
    event: '📅', events: '📅', meetup: '📅', workshop: '📅',
    deadline: '⏰', deadlines: '⏰', due: '⏰',
    marketplace: '🛒', buy: '🛒', sell: '🛒', 'buy/sell': '🛒',
    announcement: '📢', announcements: '📢', notice: '📢', update: '📢',
    job: '💼', jobs: '💼', internship: '💼', career: '💼',
    social: '💬', chat: '💬', general: '💬', conversation: '💬',
    question: '❓', questions: '❓', help: '❓', query: '❓',
    food: '🍔', sports: '⚽', travel: '✈️', finance: '💰', money: '💰',
    other: '📌', misc: '📌'
  };

  for (const [key, emoji] of Object.entries(map)) {
    if (lower.includes(key)) return emoji;
  }
  return '📌';
}

function renderDynamicChips(data) {
  const chipsContainer = el('categories');
  chipsContainer.innerHTML = '';

  if (!data || !data.categories || data.categories.length === 0) return;

  // "All" chip
  const allChip = document.createElement('div');
  allChip.className = 'chip active';
  allChip.textContent = `📋 All`;
  allChip.addEventListener('click', () => {
    currentFilter = null;
    updateChipStates(chipsContainer, null);
    renderCategorized(lastCategorizedData, lastMessages, null);
  });
  chipsContainer.appendChild(allChip);

  // Count messages per category
  const counts = {};
  if (data.messages) {
    Object.values(data.messages).forEach(m => {
      const cat = m.category || 'Other';
      counts[cat] = (counts[cat] || 0) + 1;
    });
  }

  // Dynamic category chips
  data.categories.forEach(cat => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    const count = counts[cat.name] || 0;
    chip.textContent = `${cat.emoji || '📌'} ${cat.name} (${count})`;
    chip.dataset.category = cat.name;
    chip.addEventListener('click', () => {
      currentFilter = cat.name;
      updateChipStates(chipsContainer, cat.name);
      renderCategorized(lastCategorizedData, lastMessages, cat.name);
    });
    chipsContainer.appendChild(chip);
  });
}

function updateChipStates(container, activeCategory) {
  container.querySelectorAll('.chip').forEach(chip => {
    if (activeCategory === null) {
      // "All" is active
      chip.classList.toggle('active', !chip.dataset.category);
    } else {
      chip.classList.toggle('active', chip.dataset.category === activeCategory);
    }
  });
}

function renderCategorized(data, messages, filterCategory) {
  const container = el('messages');
  container.innerHTML = '';

  if (!data || !data.messages || Object.keys(data.messages).length === 0) {
    container.innerHTML = '<div class="meta">No categorized items.</div>';
    return;
  }

  const urgencyColors = {
    high: '#e74c3c',
    medium: '#f39c12',
    low: '#95a5a6'
  };

  // Build category → items map
  const grouped = {};
  Object.keys(data.messages).forEach(k => {
    const idx = Number(k) - 1;
    const meta = data.messages[k];
    const m = messages[idx];
    if (!m) return;
    const cat = (meta && meta.category) || 'Other';

    // If filtering, skip non-matching categories
    if (filterCategory && cat !== filterCategory) return;

    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push({ meta, message: m });
  });

  if (Object.keys(grouped).length === 0) {
    container.innerHTML = '<div class="meta">No messages in this category.</div>';
    return;
  }

  // Find emoji for each category from the categories list
  const emojiLookup = {};
  if (data.categories) {
    data.categories.forEach(c => { emojiLookup[c.name] = c.emoji; });
  }

  Object.keys(grouped).forEach(cat => {
    const items = grouped[cat];
    const emoji = emojiLookup[cat] || pickEmoji(cat);

    const header = document.createElement('div');
    header.className = 'category-header';
    header.textContent = `${emoji} ${cat} (${items.length})`;
    container.appendChild(header);

    items.forEach(({ meta, message: m }) => {
      const div = document.createElement('div');
      div.className = 'card';

      const cardTop = document.createElement('div');
      cardTop.className = 'card-top';

      const cardClickArea = document.createElement('div');
      cardClickArea.className = 'card-click-area';

      const titleRow = document.createElement('div');
      titleRow.className = 'card-title-row';

      const title = document.createElement('span');
      title.className = 'card-title';
      title.textContent = (meta && meta.title) ? meta.title : (m && m.text.slice(0, 80));
      titleRow.appendChild(title);

      if (meta?.urgency) {
        const urgencyBadge = document.createElement('span');
        urgencyBadge.className = 'urgency-badge';
        urgencyBadge.textContent = meta.urgency.toUpperCase();
        urgencyBadge.style.color = urgencyColors[meta.urgency] || '#95a5a6';
        titleRow.appendChild(urgencyBadge);
      }

      const sub = document.createElement('div');
      sub.className = 'meta';
      sub.textContent = `${m?.sender || 'Unknown'} • ${m?.timestamp || ''}`;

      cardClickArea.appendChild(titleRow);
      cardClickArea.appendChild(sub);
      cardClickArea.addEventListener('click', async () => {
        await jumpToChat(div, m);
      });

      const arrow = document.createElement('button');
      arrow.className = 'expand-arrow';
      arrow.innerHTML = '&#9662;';
      arrow.title = 'Show full message';

      const expandBody = document.createElement('div');
      expandBody.className = 'expand-body';

      // Render extracted details as key-value tags
      if (meta?.details && typeof meta.details === 'object' && Object.keys(meta.details).length > 0) {
        const detailsDiv = document.createElement('div');
        detailsDiv.className = 'details-grid';
        Object.entries(meta.details).forEach(([key, value]) => {
          const tag = document.createElement('span');
          tag.className = 'detail-tag';
          const keySpan = document.createElement('span');
          keySpan.className = 'detail-key';
          keySpan.textContent = key;
          const valSpan = document.createElement('span');
          valSpan.className = 'detail-val';
          valSpan.textContent = value;
          tag.appendChild(keySpan);
          tag.appendChild(valSpan);
          detailsDiv.appendChild(tag);
        });
        expandBody.appendChild(detailsDiv);
      }

      // Full original message
      const fullMsg = document.createElement('div');
      fullMsg.className = 'full-msg';
      fullMsg.textContent = m?.text || '(no text)';
      expandBody.appendChild(fullMsg);

      arrow.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = div.classList.toggle('expanded');
        arrow.innerHTML = open ? '&#9652;' : '&#9662;';
      });

      cardTop.appendChild(cardClickArea);
      cardTop.appendChild(arrow);
      div.appendChild(cardTop);
      div.appendChild(expandBody);
      container.appendChild(div);
    });
  });
}

// Jump to a message in the WhatsApp chat with visual feedback
async function jumpToChat(cardDiv, message) {
  const tab = await getActiveTab();
  if (!tab) return;

  // Visual feedback on the card
  cardDiv.style.transition = 'background-color 0.2s';
  cardDiv.style.backgroundColor = 'rgba(37, 211, 102, 0.15)';
  cardDiv.querySelector('.meta').textContent += ' • Jumping...';

  try {
    const resp = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id, {
        type: 'jumpToMessage',
        id: message.id,
        text: message.text || '',
        sender: message.sender || ''
      }, (response) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        resolve(response);
      });
    });

    if (resp && resp.ok) {
      cardDiv.style.backgroundColor = 'rgba(37, 211, 102, 0.1)';
      setTimeout(() => { cardDiv.style.backgroundColor = ''; }, 1000);
    } else {
      cardDiv.style.backgroundColor = 'rgba(231, 76, 60, 0.1)';
      const metaEl = cardDiv.querySelector('.meta');
      if (metaEl) metaEl.textContent = metaEl.textContent.replace(' • Jumping...', ' • Not found');
      setTimeout(() => {
        cardDiv.style.backgroundColor = '';
        if (metaEl) metaEl.textContent = metaEl.textContent.replace(' • Not found', '');
      }, 2000);
    }
  } catch (e) {
    cardDiv.style.backgroundColor = 'rgba(231, 76, 60, 0.1)';
    setTimeout(() => { cardDiv.style.backgroundColor = ''; }, 1500);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  el('refresh').addEventListener('click', refresh);
  el('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  refresh();
});
