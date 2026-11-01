# SEVA Technical Note — Dual AI Provider Strategy (Local Ollama vs. Claude API)

---

## 📌 Executive Summary

This document outlines the proposal and implementation pattern for supporting a **Dual AI Provider Architecture** in SEVA. It allows the system to seamlessly switch between local offline inference (**Ollama with Phi-3.5**) and cloud AI inference (**Claude 3.5 Haiku via Anthropic API**) using a single environment variable (`AI_PROVIDER`).

---

## 1. Context & Motivation

SEVA is built on a **privacy-first, local-only** philosophy. By default, it uses Ollama running Microsoft Phi-3.5 locally on `localhost:11434`.

However, during final project evaluation, guide demonstrations, or advanced conversational testing, having an optional online AI fallback (Claude API) provides several advantages:
* **Zero Local RAM/GPU Usage**: Offloads compute from low-spec laptops.
* **Higher Language Intelligence**: Superior understanding of mixed Hindi+English (Hinglish) conversational nuances.
* **Near-Instant Inference**: API response times of ~0.3s – 0.5s for video recordings and live panels.

---

## 2. Local Ollama vs. Claude API Comparison Matrix

| Criteria | Local Ollama (`phi3.5`) | Claude API (`claude-3-5-haiku`) |
| :--- | :--- | :--- |
| **Privacy** | 🔒 100% Local (No network data transfer) | ☁️ Online (Data sent to Anthropic servers) |
| **Cost** | 💰 100% Free Forever | 💳 ~$0.001 per request (~₹40–80/month) |
| **Internet Dependency** | 📶 Works 100% Offline | 🌐 Requires Active Internet |
| **Hardware Overhead** | Uses ~2.2 GB RAM & local CPU/GPU | ⚡ Zero local hardware load |
| **Hinglish/Hindi Quality** | Basic understanding | Exceptional native Hinglish fluency |
| **JSON Reliability** | Enforced via `format: 'json'` + Guards | Native 100% JSON compliance |

---

## 3. Recommended Code Architecture (Strategy Pattern)

Because SEVA isolates all AI inference logic inside [backend/services/aiService.js](file:///c:/SEVA/backend/services/aiService.js), adding Claude API support requires **zero changes** to Express routes, database tables, or server scripts.

### 1. Update `backend/.env`
```env
# AI Provider Selection: 'ollama' (default) or 'claude'
AI_PROVIDER=ollama

# Anthropic API Key (Required only if AI_PROVIDER=claude)
ANTHROPIC_API_KEY=your_claude_api_key_here
```

### 2. Implementation Pattern in `backend/services/aiService.js`

```javascript
const ollama = require('ollama').default || require('ollama');
const Anthropic = require('@anthropic-ai/sdk');

// Check environment selection
const AI_PROVIDER = process.env.AI_PROVIDER || 'ollama';

// Initialize Anthropic client if API key is provided
let anthropicClient = null;
if (process.env.ANTHROPIC_API_KEY) {
  anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

/**
 * Universal analyzeEmail dispatcher routing to selected provider
 */
async function analyzeEmail(emailContent) {
  if (AI_PROVIDER === 'claude' && anthropicClient) {
    return analyzeEmailWithClaude(emailContent);
  }
  return analyzeEmailWithOllama(emailContent);
}

/**
 * Claude API Email Analyzer Implementation
 */
async function analyzeEmailWithClaude(emailContent) {
  try {
    const response = await anthropicClient.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Analyze this email and return ONLY JSON: { "event_type": "meeting"|"deadline"|"opportunity"|"general", "priority": "high"|"medium"|"low", "time": "time string or null", "summary": "under 15 words" }
Subject: ${emailContent.subject}
From: ${emailContent.sender}
Body: ${emailContent.body_preview}`
      }]
    });

    const text = response.content[0].text;
    return JSON.parse(text);
  } catch (err) {
    console.error('Claude API Error, falling back to Ollama:', err.message);
    return analyzeEmailWithOllama(emailContent);
  }
}
```

---

## 4. Key Takeaways for Mini-Project Evaluation

1. **Demonstrates Software Engineering Design Patterns**: Implementing a dual provider using the **Strategy Pattern** demonstrates solid software architecture to project guides and external examiners.
2. **Project Adaptability**: Shows that the application is modular and not tightly coupled to a single vendor or model.
3. **Best of Both Worlds**: Allows evaluating privacy-first local AI during normal operation, while keeping a high-performance cloud option ready for final live presentations.

---
*End of Technical Note*
