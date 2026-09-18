const express = require('express');
const router = express.Router();

// GET /api/summary/generate - Generate tonight's night summary
router.get('/generate', (req, res) => {
  res.json({ message: 'Generate night summary endpoint ready' });
});

// GET /api/summary/history - Get all past night summaries
router.get('/history', (req, res) => {
  res.json({ message: 'Get summary history endpoint ready', history: [] });
});

module.exports = router;
