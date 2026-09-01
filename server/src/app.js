require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth.routes');
const documentRoutes = require('./routes/document.routes');
const registrationsRoutes = require('./routes/registrations.routes');
const { UPLOAD_DIR } = require('./middleware/upload.middleware');

const app = express();

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));

app.use((req, res, next) => {
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode}`);
  });
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/document', documentRoutes);
app.use('/api/registrations', registrationsRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

module.exports = app;
