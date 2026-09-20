import axios from 'axios';

// Shared axios instance — import this in every screen, never hardcode the URL
const client = axios.create({
  baseURL: 'http://localhost:3001/api',
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
  },
});

export default client;
