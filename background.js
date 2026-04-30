let ephemeralKey = null;

// Helper: get API key (ephemeral first, then persistent)
async function getApiKey() {
  if (ephemeralKey) return ephemeralKey;
  const data = await chrome.storage.local.get(['apiKey', 'storeMode']);
  if (data && data.storeMode === 'ephemeral' && data.apiKey) {
    // if user mistakenly left apiKey in storage but chose ephemeral, prefer ephemeralKey
  }
  return data && data.apiKey ? data.apiKey : null;
}

// Exponential backoff helper
async function withRetries(fn, attempts = 3, initialDelay = 500) {
  let i = 0;
  let delay = initialDelay;
  while (i < attempts) {
    try {
      return await fn();
    } catch (err) {
      i++;
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

// Groq-only: call Groq (via callLlamaAPI) and return parsed JSON
async function callLLMWithFallback(prompt, messagesArray) {
  const key = await getApiKey();
  if (!key) throw new Error('no_api_key');

  // Use Groq only (no Gemini)
  console.log('[background] Using Groq API only');
  
  try {
    const cfg = await chrome.storage.local.get(['llamaModel']);
    const model = (cfg && cfg.llamaModel) || 'llama-3.3-70b-versatile';
    
    const groqResp = await withRetries(() => callLlamaAPI(key, null, model, prompt), 3, 500);
    const parsed = extractJSON(groqResp);
    if (parsed) return parsed;
    
    // If extractJSON failed but we got a response, return it
    if (groqResp) return groqResp;
    
  } catch (e) {
    console.error('[background] Groq API failed:', e);
    throw new Error('groq_failed: ' + String(e));
  }

  throw new Error('llm_failed');
}

async function callGeminiAPI(apiKey, prompt) {
  console.debug('[background] callGeminiAPI start');
  // Build URL with API key as query parameter (Gemini expects key in URL for simple API key usage)
  // Read configured model from storage
  const cfg = await chrome.storage.local.get(['llamaModel']);
  const model = cfg && cfg.llamaModel;
  if (!model) {
    throw new Error('no_gemini_model: set the "Model" field in Options to a Gemini model ID.\nList available models with:\n  curl "https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY"');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.0,
          maxOutputTokens: 1024
        }
      })
    });

    if (!resp.ok) {
      let errorData = null;
      try { errorData = await resp.json(); } catch (e) { errorData = await resp.text(); }
      console.warn('[background] callGeminiAPI non-ok response', resp.status, errorData);
      throw new Error('gemini_error:' + (errorData && (errorData.message || JSON.stringify(errorData)) || resp.status));
    }

    const data = await resp.json();
    console.debug('[background] callGeminiAPI success', data);

    // Gemini returns candidates with content parts; extract text
    const resultText = data?.candidates?.[0]?.content?.[0]?.text || data?.output?.[0]?.content?.[0]?.text || JSON.stringify(data);

    // Clean code fences and extract JSON object if wrapped
    let cleaned = String(resultText).replace(/```json\n?/g, '').replace(/```/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleaned = jsonMatch[0];

    try {
      return JSON.parse(cleaned);
    } catch (e) {
      // If parsing fails, return raw text so caller can handle it
      console.warn('[background] callGeminiAPI JSON parse failed, returning raw text');
      return cleaned;
    }
  } catch (err) {
    console.error('[background] callGeminiAPI error', err);
    throw err;
  }
}

async function callLlamaAPI(apiKey, llamaEndpoint, llamaModel, prompt) {
  console.log('[background] callLlamaAPI called with Groq');

  const url = 'https://api.groq.com/openai/v1/chat/completions';

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{
          role: 'user',
          content: prompt
        }],
        temperature: 0.5,
        max_tokens: 2048
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('[background] Groq API error', response.status, errorData);
      throw new Error(`Groq error: ${JSON.stringify(errorData)}`);
    }

    const data = await response.json();
    console.log('[background] Groq API success');
    
    const resultText = data.choices[0].message.content;
    
    // Clean and parse JSON
    let cleaned = resultText.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleaned = jsonMatch[0];
    }
    
    return JSON.parse(cleaned);
    
  } catch (error) {
    console.error('[background] Groq API error', error);
    throw error;
  }
}

function extractJSON(text) {
  if (!text) return null;
  // If it's already an object, return as-is
  if (typeof text === 'object') return text;
  // Ensure we have a string to operate on
  if (typeof text !== 'string') text = String(text);
  try {
    return JSON.parse(text);
  } catch (e) {
    // try to find JSON substring
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

async function categorizeMessages(messages) {
  // If mock mode enabled, return a deterministic mock categorization
  try {
    const cfg = await chrome.storage.local.get(['mockMode']);
    if (cfg && cfg.mockMode) {
      return mockCategorize(messages);
    }
  } catch (e) {
    // ignore and proceed to real LLM
  }

  const promptHeader = `You are an intelligent WhatsApp message analyzer. Your goal: extract what the USER would want to know at a glance.

Think like a human:
- "What's important here?"
- "What would I want to remember from this message?"
- "Is this actionable, informative, or just casual chat?"

Use your intelligence to identify patterns and extract relevant details. Here are EXAMPLES of how to think (not rigid rules):

HOUSING / REAL ESTATE:
  Recognize: flat, apartment, PG, room, house, BHK, rent, deposit, property
  Extract: BHK/type, price, location, rent vs sale, amenities
  Example title: "2BHK Bandra, ₹18k/month" or "PG Andheri, ₹8k with food"

EVENTS / HACKATHONS / WORKSHOPS:
  Recognize: hackathon, fest, workshop, competition, seminar, meetup
  Extract: event name, date/time, venue, theme, prize, registration deadline
  Example title: "Hack4Innovation - AI/ML, ₹50k prize"

DEADLINES / URGENT ACTIONS:
  Recognize: deadline, due date, last date, submit by, register before
  Extract: what's due, when, where to submit
  Example title: "Assignment due Friday 5 PM - portal"
  Always mark urgency: "high"

OPPORTUNITIES (Jobs/Internships/Sponsorships):
  Recognize: hiring, internship, job, opening, sponsor, scholarship, stipend
  Extract: company/org, role type, deadline, how to apply, benefits
  Example title: "Google internship - apply by May 1"

ANNOUNCEMENTS (Official/Important):
  Recognize: notice, cancelled, rescheduled, released, official, update
  Extract: what changed, when, why, action needed
  Example title: "Classes cancelled tomorrow - strike"

PERSONAL / DIRECT MESSAGES:
  Recognize: 1-on-1 intent, requests, questions, plans
  Extract: intent/purpose, time-sensitive info, requests
  Example title: "Wants to meet tomorrow 5 PM for project"

SOCIAL / CASUAL:
  Recognize: greetings, jokes, memes, emoji-heavy, banter
  Title: Keep minimal like "Casual chat" or "Good morning"
  Always mark urgency: "low"

OTHER PATTERNS - use your intelligence:
  Food/restaurant recs, travel plans, lost & found, urgent help, polls, study groups, etc.
  Create appropriate category names and extract relevant details.

RESPONSE FORMAT — return ONLY this JSON, nothing else:
{
  "categories": [
    {"name": "CategoryName", "emoji": "🏠"}
  ],
  "messages": {
    "1": {
      "category": "CategoryName",
      "title": "Crisp natural summary with key details",
      "urgency": "low|medium|high",
      "details": {}
    }
  }
}

RULES:
- Categories: short (1-2 words), capitalized, with fitting emoji. Create 3-8 based on what you see.
- Title: max 50 chars, natural language, most important detail first. NOT robotic.
  Good: "2BHK Bandra, ₹18k/month"  Bad: "Real estate: 2BHK property available..."
  Good: "Meet tomorrow 5 PM - project"  Bad: "Personal: meeting request from user"
- Urgency: high = deadlines/time-sensitive, medium = events/opportunities/housing, low = casual/social
- Details: extract key-value pairs YOU think are important for that category. Use your judgment.
  Housing example: {"bhk": "2BHK", "price": "₹18k/month", "location": "Bandra", "type": "Rent"}
  Event example: {"name": "Hack4Innovation", "theme": "AI/ML", "prize": "₹50k", "deadline": "Friday"}
  Personal example: {"intent": "Meeting request", "when": "Tomorrow 5 PM", "topic": "Project"}
  Casual example: {} (empty is fine)
- Handle Indian context: ₹, k/L/cr, Indian cities/colleges, Hinglish, DD/MM dates
- Every message index (1-based) MUST appear in "messages"
- Return ONLY valid JSON`;

  const msgsText = messages.map((m, i) => `${i + 1}. [${m.sender || 'Unknown'}]: ${m.text || ''}`).join('\n');
  const prompt = `${promptHeader}\n\nMessages:\n${msgsText}`;

  const categorized = await callLLMWithFallback(prompt, messages);
  return categorized;
}

function mockCategorize(messages) {
  // Keyword-based mock for offline mode — matches the new format
  const categoryMap = {};
  const detectedCats = new Set();

  messages.forEach((m, idx) => {
    const text = (m.text || '').toLowerCase();
    let category = 'General';
    let details = {};
    let urgency = 'low';

    if (text.includes('bhk') || text.includes('flat') || text.includes('rent') || text.includes('room') || text.includes('pg') || text.includes('house')) {
      category = 'Housing';
      // Try to extract price
      const priceMatch = text.match(/(\d+\.?\d*)\s*k/i) || text.match(/₹\s*(\d+[\d,]*)/);
      const bhkMatch = text.match(/(\d)\s*bhk/i);
      details = {};
      if (bhkMatch) details.bhk = bhkMatch[1] + 'BHK';
      if (priceMatch) details.price = '₹' + priceMatch[1] + (text.includes('k') ? 'k' : '');
      if (text.includes('rent')) details.type = 'Rent';
      else if (text.includes('sell') || text.includes('sale')) details.type = 'Sale';
      else if (text.includes('pg')) details.type = 'PG';
      urgency = 'medium';
    } else if (text.includes('hack') || text.includes('workshop') || text.includes('fest') || text.includes('event') || text.includes('seminar')) {
      category = 'Events';
      details = {};
      if (text.includes('hack')) details.type = 'Hackathon';
      else if (text.includes('workshop')) details.type = 'Workshop';
      else details.type = 'Event';
      urgency = 'medium';
    } else if (text.includes('deadline') || text.includes('due') || text.includes('submit') || text.includes('last date')) {
      category = 'Deadlines';
      details = { action: 'Check deadline' };
      urgency = 'high';
    } else if (text.includes('hiring') || text.includes('internship') || text.includes('job') || text.includes('opening') || text.includes('sponsor')) {
      category = 'Opportunities';
      details = {};
      if (text.includes('internship')) details.type = 'Internship';
      else if (text.includes('job') || text.includes('hiring')) details.type = 'Job';
      else if (text.includes('sponsor')) details.type = 'Sponsorship';
      urgency = 'medium';
    } else if (text.includes('cancel') || text.includes('notice') || text.includes('announce') || text.includes('update') || text.includes('schedule')) {
      category = 'Announcements';
      details = {};
      urgency = 'medium';
    } else if (text.includes('meet') || text.includes('call me') || text.includes('can you') || text.includes('please')) {
      category = 'Personal';
      details = { intent: 'Request/plan' };
      urgency = 'low';
    } else if (text.includes('haha') || text.includes('lol') || text.includes('good morning') || text.includes('😂') || text.length < 15) {
      category = 'Social';
      details = {};
      urgency = 'low';
    }

    detectedCats.add(category);

    const words = (m.text || '').split(/\s+/).filter(Boolean);
    const title = words.slice(0, 8).join(' ').slice(0, 50) || (m.text || '').slice(0, 50);

    categoryMap[String(idx + 1)] = { category, title, urgency, details };
  });

  const emojiMap = { Housing: '🏠', Events: '📅', Deadlines: '⏰', Opportunities: '💼', Announcements: '📢', Personal: '💬', Social: '🎉', General: '📌' };
  const categories = Array.from(detectedCats).map(name => ({ name, emoji: emojiMap[name] || '📌' }));

  return { categories, messages: categoryMap };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Handle messagesExtracted: acknowledge receipt (prevents port-closed error)
  if (msg && msg.type === 'messagesExtracted') {
    console.debug('[background] messagesExtracted received, count=', (msg.messages || []).length);
    sendResponse({ ok: true });
    return true;
  }

  if (msg && msg.type === 'testKey') {
    (async () => {
      try {
        const apiKey = msg.apiKey;
        const endpoint = msg.llamaEndpoint;
        const model = msg.llamaModel || 'llama-3.3-70b-versatile';
        const mock = msg.mockMode;
        
        if (mock) {
          sendResponse({ ok: true, message: 'Mock mode enabled' });
          return;
        }

        if (!apiKey) {
          sendResponse({ ok: false, message: 'No API key provided' });
          return;
        }

        // Test Groq API
        console.log('[background] Testing Groq API key');
        const url = 'https://api.groq.com/openai/v1/chat/completions';
        
        try {
          const resp = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              model: model,
              messages: [{
                role: 'user',
                content: 'Test connection: reply OK'
              }],
              max_tokens: 10
            })
          });

          if (!resp.ok) {
            let errorData = null;
            try { errorData = await resp.json(); } catch (e) { errorData = await resp.text(); }
            sendResponse({ 
              ok: false, 
              message: `Groq error ${resp.status}: ${JSON.stringify(errorData)}` 
            });
            return;
          }

          const data = await resp.json();
          console.log('[background] Groq test successful');
          sendResponse({ ok: true, message: '✅ Groq API key works!' });
          return;
          
        } catch (err) {
          console.error('[background] Groq test failed:', err);
          sendResponse({ ok: false, message: `Groq test failed: ${String(err)}` });
          return;
        }
        
      } catch (err) {
        sendResponse({ ok: false, message: String(err) });
      }
    })();
    return true;
  }
  if (msg && msg.type === 'setEphemeralKey') {
    console.debug('[background] setEphemeralKey received');
    ephemeralKey = msg.key || null;
    sendResponse({ ok: true });
    return true;
  }

  if (msg && msg.type === 'getEphemeralKey') {
    sendResponse({ key: ephemeralKey });
    return true;
  }

  if (msg && msg.type === 'setBadge') {
    const text = msg.text || '';
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: '#FF4444' });
    sendResponse({ ok: true });
    return true;
  }

  if (msg && msg.type === 'categorizeMessages') {
    console.debug('[background] categorizeMessages request received, count=', (msg.messages || []).length);
    (async () => {
      try {
        const result = await categorizeMessages(msg.messages || []);
        console.debug('[background] categorizeMessages succeeded');
        sendResponse({ ok: true, result });
      } catch (e) {
        console.error('[background] categorizeMessages error', e);
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
});
