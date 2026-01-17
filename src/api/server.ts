import express from 'express';
import path from 'path';
import { testConnection } from '../config/database';
import balanceRoutes from './routes/balance';
import bigqueryRoutes from './routes/bigquery';
import positionsRoutes from './routes/positions';
import goldskyWebhookRoutes from './routes/goldsky-webhook';
import cronPricesRoutes from './routes/cron-prices';
import tokensRoutes from './routes/tokens';
import tokenStatisticsRoutes from './routes/token-statistics';
import exploreRoutes from './routes/explore';
import metadataRoutes from './routes/metadata';
import emissionApyRoutes from './routes/emission-apy';

const app = express();

// Middleware
app.use(express.json());

// CORS (if needed for frontend)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  next();
});

// Health check
app.get('/health', async (req, res) => {
  const dbConnected = await testConnection();
  res.json({
    status: 'ok',
    database: dbConnected ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
  });
});

// API routes
app.use('/api', balanceRoutes);
app.use('/api/bigquery', bigqueryRoutes);
app.use('/api/positions', positionsRoutes);
app.use('/api/goldsky', goldskyWebhookRoutes);
app.use('/api/cron', cronPricesRoutes);
app.use('/api/tokens', tokensRoutes);
app.use('/api/token-statistics', tokenStatisticsRoutes);
app.use('/api/explore', exploreRoutes);
app.use('/api/metadata', metadataRoutes);
app.use('/api/emission-apy', emissionApyRoutes);

// Serve static files from frontend/dist directory
app.use(express.static(path.join(__dirname, '../../frontend/dist')));

// Catch-all route - serve React app for any non-API routes
app.get('*', (req, res) => {
  // Only serve index.html for non-API routes
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '../../frontend/dist/index.html'));
  } else {
    res.status(404).json({
      error: 'Not found',
      message: `Route ${req.method} ${req.path} not found`,
    });
  }
});

// Try to listen on a port, returns a promise
function tryListen(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port)
      .once('listening', () => resolve(port))
      .once('error', (err: NodeJS.ErrnoException) => {
        server.close();
        reject(err);
      });
  });
}

// Start server
async function startServer() {
  const basePort = 3008;
  const maxAttempts = 10;

  try {
    // Test database connection
    console.log('Testing database connection...');
    const connected = await testConnection();

    if (!connected) {
      throw new Error('Failed to connect to database');
    }

    // Try ports starting from basePort
    let PORT: number | null = null;
    for (let i = 0; i < maxAttempts; i++) {
      const tryPort = basePort + i;
      try {
        PORT = await tryListen(tryPort);
        break;
      } catch (err: any) {
        if (err.code === 'EADDRINUSE') {
          console.log(`Port ${tryPort} is busy, trying ${tryPort + 1}...`);
        } else {
          throw err;
        }
      }
    }

    if (PORT === null) {
      throw new Error(`Could not find an available port (tried ${basePort}-${basePort + maxAttempts - 1})`);
    }

    console.log('\n' + '='.repeat(60));
    console.log('  BLEND BACKFILL API SERVER');
    console.log('='.repeat(60));
    console.log(`  Server running on http://localhost:${PORT}`);
    console.log('');
    console.log('  Available endpoints:');
    console.log(`    GET  /                           (React Web UI)`);
    console.log(`    GET  /health`);
    console.log('');
    console.log('  OPTIMIZED Position Queries:');
    console.log(`    GET  /api/positions/user/:address`);
    console.log(`    GET  /api/positions/user/:address/all-assets`);
    console.log(`    GET  /api/positions/bulk`);
    console.log(`    GET  /api/positions/cached/:user/:asset`);
    console.log('');
    console.log('  Legacy Balance Endpoints:');
    console.log(`    GET  /api/balance/:user/:asset`);
    console.log(`    GET  /api/balance/:user/:asset/history`);
    console.log(`    GET  /api/stats`);
    console.log('');
    console.log('  Backfill Endpoints:');
    console.log(`    POST /api/backfill/pool`);
    console.log(`    POST /api/backfill/users`);
    console.log(`    POST /api/bigquery/backfill`);
    console.log(`    GET  /api/bigquery/config`);
    console.log(`    GET  /api/bigquery/status`);
    console.log('');
    console.log('  Real-time Streaming (Goldsky):');
    console.log(`    POST /api/goldsky/webhook`);
    console.log(`    GET  /api/goldsky/status`);
    console.log('');
    console.log('  Price Capture (Cron):');
    console.log(`    POST /api/cron/capture-prices`);
    console.log(`    GET  /api/cron/prices/status`);
    console.log('');
    console.log('  Sync Reference Tables:');
    console.log(`    GET  /api/bigquery/sync/stats`);
    console.log(`    POST /api/bigquery/sync/run`);
    console.log('');
    console.log('  Explore & Metadata:');
    console.log(`    GET  /api/explore`);
    console.log(`    GET  /api/metadata`);
    console.log('='.repeat(60) + '\n');
    if (process.env.NODE_ENV !== 'production') {
      console.log(`  API running on http://localhost:${PORT}`);
      console.log(`  For development, open http://localhost:5173\n`);
    } else {
      console.log(`  Open http://localhost:${PORT} for the Web UI\n`);
    }

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
