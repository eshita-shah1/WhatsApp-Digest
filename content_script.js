(() => {
  console.log('✅ [WhatsApp Summarizer] Content script loaded on WhatsApp Web');

  // --- Selector Strategy ---
  // WhatsApp Web uses obfuscated class names that change frequently.
  // We prioritize stable attributes: data-testid, data-id, role, aria-*, and
  // semantic patterns. Multiple fallbacks are tried in order.
  const selectors = {
    // The main chat panel
    chatPanel: [
      '#main',
      'div[data-testid="conversation-panel-body"]',
      'div[role="application"]'
    ],
    // Individual message containers (rows)
    message: [
      'div[data-testid="msg-container"]',
      'div[role="row"]',
      'div[data-id]',
      '.message-in, .message-out',
      'div[class*="message-"]'
    ],
    // Text content inside a message
    text: [
      'span[data-testid="msg-text"]',             // direct test-id for text
      'span[data-lexical-text="true"]',            // Lexical editor nodes (newer)
      'span.selectable-text span',                 // nested selectable text
      '.selectable-text',                          // selectable text wrapper
      'span[dir="ltr"]',                           // LTR text spans
      'span[dir="rtl"]',                           // RTL text spans
      'div.copyable-text span',                    // copyable text children
      'span.copyable-text',                        // copyable text span
      'div.copyable-text'                          // copyable text div
    ],
    // Sender name (primarily relevant in group chats)
    sender: [
      'span[data-testid="author-name"]',           // test-id for author
      'div[data-testid="msg-author-name"]',        // alternate author test-id
      'span[aria-label][dir="auto"]',              // aria-label author spans
      'div.copyable-text[data-pre-plain-text]'     // parse from pre-plain-text attr
    ],
    // Timestamp
    timestamp: [
      'div[data-testid="msg-meta"] span',          // meta span inside msg-meta
      'div[data-testid="msg-meta"]',               // msg-meta container
      'span[data-testid="msg-time"]',              // direct time test-id
      'time',                                       // <time> element
      'span[aria-label]'                            // aria-label with time info
    ]
  };

  function robustQuery(selectorArray, root = document) {
    for (let sel of selectorArray) {
      try {
        const elements = root.querySelectorAll(sel);
        if (elements && elements.length > 0) return elements;
      } catch (e) {
        // invalid selector, skip
      }
    }
    return [];
  }

  function robustQueryOne(selectorArray, root = document) {
    for (let sel of selectorArray) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (e) {
        // skip
      }
    }
    return null;
  }

  function debugSelectorCounts() {
    try {
      const counts = {};
      Object.keys(selectors).forEach((k) => {
        counts[k] = selectors[k].map((sel) => {
          try { return `${sel}: ${document.querySelectorAll(sel).length}`; } catch (e) { return `${sel}: ERR`; }
        });
      });
      console.debug('[content_script] selector counts', JSON.stringify(counts, null, 2));
    } catch (e) {
      // ignore
    }
  }

  let lastExtracted = [];
  let sendTimer = null;

  function extractText(msgEl) {
    // Strategy 1: Find text via dedicated selectors
    const textEl = robustQueryOne(selectors.text, msgEl);
    if (textEl) {
      const t = textEl.textContent.trim();
      if (t) return t;
    }

    // Strategy 2: Gather all Lexical text nodes (newer WhatsApp)
    try {
      const lexicalNodes = msgEl.querySelectorAll('span[data-lexical-text="true"]');
      if (lexicalNodes.length > 0) {
        const combined = Array.from(lexicalNodes).map(n => n.textContent).join('');
        if (combined.trim()) return combined.trim();
      }
    } catch (e) {}

    // Strategy 3: data-pre-plain-text attribute parsing
    try {
      const pre = msgEl.querySelector('[data-pre-plain-text]');
      if (pre) {
        const preAttr = pre.getAttribute('data-pre-plain-text') || '';
        const full = (pre.innerText || '').trim();
        // Remove the prefix "[time, date] Sender: " if present
        const cleaned = preAttr && full.startsWith(preAttr) ? full.slice(preAttr.length).trim() : full;
        if (cleaned) return cleaned;
      }
    } catch (e) {}

    // Strategy 4: data-text-content attribute
    try {
      const dtc = msgEl.querySelector('[data-text-content]');
      if (dtc) {
        const t = dtc.getAttribute('data-text-content') || dtc.textContent.trim();
        if (t) return t;
      }
    } catch (e) {}

    // Strategy 5: Last resort — get innerText but filter out noise
    try {
      const innerText = (msgEl.innerText || '').trim();
      // Only return if it looks like actual message content (not just timestamps)
      if (innerText && innerText.length > 2 && !/^\d{1,2}:\d{2}$/.test(innerText)) {
        // Limit to first meaningful chunk
        return innerText.split('\n')[0].trim();
      }
    } catch (e) {}

    return '';
  }

  function extractSender(msgEl) {
    // Strategy 1: data-testid author-name
    const authorEl = robustQueryOne(selectors.sender, msgEl);
    if (authorEl) {
      // Check if it's a data-pre-plain-text element — parse it
      const prePlain = authorEl.getAttribute && authorEl.getAttribute('data-pre-plain-text');
      if (prePlain) {
        const m = prePlain.match(/\]\s*([^:]+):/);
        if (m && m[1]) return m[1].trim();
      }
      const t = authorEl.textContent.trim();
      if (t) return t;
    }

    // Strategy 2: Parse from data-pre-plain-text on any child
    try {
      const pre = msgEl.querySelector('[data-pre-plain-text]');
      if (pre) {
        const p = pre.getAttribute('data-pre-plain-text') || '';
        const m = p.match(/\]\s*([^:]+):/);
        if (m && m[1]) return m[1].trim();
      }
    } catch (e) {}

    // Strategy 3: Check if message-in or message-out to infer direction
    try {
      if (msgEl.classList.contains('message-out') || msgEl.querySelector('.message-out')) {
        return 'You';
      }
    } catch (e) {}

    return '';
  }

  function extractTimestamp(msgEl) {
    // Strategy 1: data-testid msg-meta or msg-time
    const tsEl = robustQueryOne(selectors.timestamp, msgEl);
    if (tsEl) {
      const dt = tsEl.getAttribute('datetime');
      if (dt) return dt;
      const t = tsEl.textContent.trim();
      if (t) return t;
    }

    // Strategy 2: From data-pre-plain-text
    try {
      const pre = msgEl.querySelector('[data-pre-plain-text]');
      if (pre) {
        const p = pre.getAttribute('data-pre-plain-text') || '';
        // Format: "[HH:MM, DD/MM/YYYY] Sender: "
        const m = p.match(/\[([^\]]+)\]/);
        if (m && m[1]) return m[1].trim();
      }
    } catch (e) {}

    return '';
  }

  function extractMessageId(msgEl) {
    // Try various ID attributes
    return msgEl.getAttribute('data-id')
      || msgEl.getAttribute('data-message-id')
      || (msgEl.dataset && msgEl.dataset.id)
      || (msgEl.dataset && msgEl.dataset.messageId)
      || null;
  }

  function extractMessages() {
    // First check if we're on a chat page
    const chatPanel = robustQueryOne(selectors.chatPanel);
    if (!chatPanel) {
      console.debug('[content_script] No chat panel found — user may not have a chat open');
      return [];
    }

    // Find message elements within the chat panel
    let msgEls = robustQuery(selectors.message, chatPanel);

    // If nothing found in chat panel, try document-wide
    if (msgEls.length === 0) {
      msgEls = robustQuery(selectors.message);
    }

    console.debug('[content_script] extractMessages found elements=', msgEls.length);

    const results = [];
    const seen = new Set(); // deduplicate

    msgEls.forEach((el) => {
      try {
        const id = extractMessageId(el);
        const text = extractText(el);
        const sender = extractSender(el);
        const timestamp = extractTimestamp(el);

        // Skip empty messages and system messages
        if (!text) return;
        
        // Skip very short messages that are likely UI artifacts
        if (text.length < 2) return;

        // Deduplicate by text + sender + timestamp
        const dedupKey = `${sender}|${text}|${timestamp}`;
        if (seen.has(dedupKey)) return;
        seen.add(dedupKey);

        results.push({ id, sender, text, timestamp });
      } catch (e) {
        // tolerate individual message extraction errors
        console.debug('[content_script] error extracting single message:', e);
      }
    });

    lastExtracted = results;
    console.debug('[content_script] extractMessages returning count=', results.length);

    if (results.length === 0) {
      debugSelectorCounts();
      // Log a sample element for debugging
      if (msgEls.length > 0) {
        console.debug('[content_script] sample message element outerHTML:', msgEls[0].outerHTML.slice(0, 1500));
      } else {
        // Log the chat panel's children to help diagnose
        console.debug('[content_script] chatPanel children count:', chatPanel.children.length);
        if (chatPanel.children.length > 0) {
          console.debug('[content_script] first child outerHTML:', chatPanel.children[0].outerHTML.slice(0, 1500));
        }
      }
    }
    return results;
  }

  // expose a flag so devtools can verify the content script is present
  try { window.whatsappSummarizerPresent = true; } catch (e) {}

  let contextInvalidated = false;

  function sendExtracted() {
    // If context was invalidated, stop trying
    if (contextInvalidated) return;

    try {
      const messages = extractMessages();
      console.debug('[content_script] sendExtracted sending messages count=', messages.length);

      if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) return;

      // Send with error handling
      try {
        chrome.runtime.sendMessage({ type: 'messagesExtracted', messages }, (resp) => {
          // Check for error silently
          if (chrome.runtime.lastError) {
            contextInvalidated = true;
            try { observer && observer.disconnect(); } catch (e) {}
          }
        });
      } catch (syncErr) {
        // Context invalidated; mark and stop
        contextInvalidated = true;
        try { observer && observer.disconnect(); } catch (e) {}
        return;
      }

      try {
        chrome.runtime.sendMessage({ type: 'setBadge', text: String(messages.length || '') }, (resp) => {
          if (chrome.runtime.lastError) {
            contextInvalidated = true;
            try { observer && observer.disconnect(); } catch (e) {}
          }
        });
      } catch (syncErr) {
        contextInvalidated = true;
        try { observer && observer.disconnect(); } catch (e) {}
      }
    } catch (e) {
      // Final safety net: silently fail and stop observing
      contextInvalidated = true;
      try { observer && observer.disconnect(); } catch (ee) {}
    }
  }

  function debouncedSend() {
    if (contextInvalidated) return;  // Don't schedule if context is invalid
    if (sendTimer) clearTimeout(sendTimer);
    sendTimer = setTimeout(() => sendExtracted(), 400);
  }

  // Initial extraction — wait for WhatsApp to fully render
  // WhatsApp Web is an SPA, so we need to wait for the chat to load
  function waitForChatAndExtract() {
    let attempts = 0;
    const maxAttempts = 15; // ~15 seconds
    const interval = setInterval(() => {
      attempts++;
      const chatPanel = robustQueryOne(selectors.chatPanel);
      if (chatPanel) {
        console.debug('[content_script] Chat panel found after', attempts, 'attempts');
        clearInterval(interval);
        debouncedSend();
      } else if (attempts >= maxAttempts) {
        console.debug('[content_script] Chat panel not found after', maxAttempts, 'attempts — will rely on MutationObserver');
        clearInterval(interval);
      }
    }, 1000);
  }

  document.addEventListener('readystatechange', () => {
    if (document.readyState === 'complete') waitForChatAndExtract();
  });

  // Also trigger if readyState is already complete
  if (document.readyState === 'complete') {
    waitForChatAndExtract();
  }

  // Observe DOM changes for new messages
  const observer = new MutationObserver((mutations) => {
    // Only re-extract if mutations are in the main content area
    // This reduces noise from WhatsApp UI changes
    let relevant = false;
    for (const m of mutations) {
      if (m.addedNodes.length > 0 || m.removedNodes.length > 0) {
        relevant = true;
        break;
      }
    }
    if (relevant) debouncedSend();
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Respond to popup requests
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === 'getMessages') {
      sendResponse({ messages: lastExtracted });
      return true;
    }

    if (msg.type === 'requestExtract') {
      const data = extractMessages();
      sendResponse({ messages: data });
      try {
        chrome.runtime.sendMessage({ type: 'messagesExtracted', messages: data });
      } catch (e) {
        // context may be invalidated
      }
      return true;
    }

    if (msg.type === 'jumpToMessage') {
      const messageId = msg.id;
      const searchText = msg.text || '';
      const searchSender = msg.sender || '';
      jumpToMessage(messageId, searchText, searchSender)
        .then((ok) => sendResponse({ ok }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    // Debug command: dump selector counts
    if (msg.type === 'debugSelectors') {
      debugSelectorCounts();
      sendResponse({ selectors: selectors, lastExtracted: lastExtracted.length });
      return true;
    }
  });

  // Highlight a found element with a pulsing glow effect
  function highlightElement(el) {
    const orig = {
      backgroundColor: el.style.backgroundColor,
      boxShadow: el.style.boxShadow,
      transition: el.style.transition,
      borderRadius: el.style.borderRadius
    };
    el.style.transition = 'background-color 0.3s ease, box-shadow 0.3s ease';
    el.style.backgroundColor = 'rgba(37, 211, 102, 0.25)';  // WhatsApp green tint
    el.style.boxShadow = '0 0 0 3px rgba(37, 211, 102, 0.5), 0 0 12px rgba(37, 211, 102, 0.3)';
    el.style.borderRadius = '8px';

    // Pulse effect: briefly intensify then restore
    setTimeout(() => {
      el.style.backgroundColor = 'rgba(37, 211, 102, 0.15)';
      el.style.boxShadow = '0 0 0 2px rgba(37, 211, 102, 0.3)';
    }, 800);

    setTimeout(() => {
      el.style.backgroundColor = orig.backgroundColor || '';
      el.style.boxShadow = orig.boxShadow || '';
      el.style.transition = orig.transition || '';
      el.style.borderRadius = orig.borderRadius || '';
    }, 2500);
  }

  // Find element by ID attributes
  function findElementById(messageId) {
    if (!messageId) return null;
    // Escape special chars in the ID for use in CSS selector
    const escaped = CSS.escape ? CSS.escape(messageId) : messageId.replace(/([^\w-])/g, '\\$1');
    return document.querySelector(`[data-id="${escaped}"]`)
      || document.querySelector(`[data-message-id="${escaped}"]`);
  }

  // Find element by matching text content (fallback when ID is null)
  function findElementByText(searchText, searchSender) {
    if (!searchText || searchText.length < 3) return null;

    const chatPanel = robustQueryOne(selectors.chatPanel);
    const root = chatPanel || document;

    // Get all message containers
    const msgEls = robustQuery(selectors.message, root);
    const searchLower = searchText.toLowerCase().trim();
    // Take the first ~40 chars for comparison to handle truncation
    const shortSearch = searchLower.slice(0, 40);

    let bestMatch = null;
    let bestScore = 0;

    for (const el of msgEls) {
      const elText = (el.innerText || '').toLowerCase().trim();
      if (!elText) continue;

      let score = 0;

      // Exact text match
      if (elText.includes(searchLower)) {
        score += 10;
      }
      // Partial match (first 40 chars)
      else if (elText.includes(shortSearch)) {
        score += 5;
      }
      // Loose match (check if most words match)
      else {
        const words = searchLower.split(/\s+/).filter(w => w.length > 2);
        const matchedWords = words.filter(w => elText.includes(w));
        if (matchedWords.length >= words.length * 0.6 && matchedWords.length >= 2) {
          score += 3;
        }
      }

      // Sender bonus
      if (searchSender && score > 0) {
        const senderLower = searchSender.toLowerCase();
        if (elText.includes(senderLower)) score += 2;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = el;
      }
    }

    return bestMatch;
  }

  async function jumpToMessage(messageId, searchText, searchSender) {
    console.debug('[content_script] jumpToMessage called', { messageId, searchText: searchText?.slice(0, 30), searchSender });

    let attempts = 0;
    const maxAttempts = 8;

    while (attempts < maxAttempts) {
      // Strategy 1: Find by ID
      let targetEl = findElementById(messageId);

      // Strategy 2: Find by text content
      if (!targetEl && searchText) {
        targetEl = findElementByText(searchText, searchSender);
      }

      if (targetEl) {
        console.debug('[content_script] jumpToMessage found element on attempt', attempts + 1);
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Small delay to let the scroll finish before highlighting
        await new Promise(r => setTimeout(r, 300));
        highlightElement(targetEl);
        return true;
      }

      // Scroll up to load older messages (WhatsApp uses virtual scrolling)
      const chatPanel = robustQueryOne(selectors.chatPanel);
      if (chatPanel) {
        chatPanel.scrollTop = Math.max(0, chatPanel.scrollTop - 600);
      } else {
        window.scrollBy({ top: -600, behavior: 'smooth' });
      }
      await new Promise((r) => setTimeout(r, 700));
      attempts++;
    }

    console.debug('[content_script] jumpToMessage failed after', maxAttempts, 'attempts');
    return false;
  }

})();
