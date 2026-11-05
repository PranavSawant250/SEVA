import axios from 'axios';

// Shared axios instance — import this in every screen, never hardcode the URL
const client = axios.create({
  baseURL: 'http://localhost:3001/api',
  timeout: 120000, // 120s timeout to allow for local Ollama / Phi-3.5 AI inference
  headers: {
    'Content-Type': 'application/json',
  },
});

// Interceptor to handle unauthenticated (401) states safely
client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response && error.response.status === 401) {
      localStorage.setItem('seva_logged_out', 'true');
      sessionStorage.clear();
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default client;
