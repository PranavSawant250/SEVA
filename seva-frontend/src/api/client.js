import axios from 'axios';

// Shared axios instance — import this in every screen, never hardcode the URL
const client = axios.create({
  baseURL: 'http://localhost:3001/api',
  timeout: 120000, // 120s timeout to allow for local Ollama / Phi-3.5 AI inference
  headers: {
    'Content-Type': 'application/json',
  },
});

export default client;
