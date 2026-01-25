"""
WatchFn Example: Express.js API Monitoring

This example demonstrates comprehensive monitoring of an Express API with:
- Automatic request tracking
- Database query tracing
- Error tracking
- Custom business metrics
- Alerts
"""

import express from 'express';
import { watchFn, createExpressMiddleware, createExpressRouter, DatabaseTracer, AlertManager } from '@watchfn/sdk';

// Initialize WatchFn
const watcher = watchFn('express-api', {
  storage: 'memory',
  enableAPM: true,
  enableErrorTracking: true,
});

// Setup database tracer
const dbTracer = new DatabaseTracer(
  (name, data) => watcher.track(name, data),
  { slowThreshold: 100 }
);

// Setup alerts
const alertManager = new AlertManager();
alertManager.register({
  id: 'high-error-rate',
  name: 'High Error Rate',
  enabled: true,
  condition: {
    type: 'threshold',
    metric: 'errors.count',
    operator: 'gt',
    threshold: 10,
    window: '5m',
    aggregation: 'sum'
  },
  severity: 'critical',
  channels: ['slack']
});

// Create Express app
const app = express();
app.use(express.json());

// Add WatchFn middleware for automatic tracking
app.use(createExpressMiddleware(watcher));

// Mount WatchFn dashboard routes
app.use('/watch', createExpressRouter(watcher));

// Example routes with monitoring

app.get('/api/users', async (req, res) => {
  try {
    // Trace database query
    const users = await dbTracer.traceQuery(
      'SELECT * FROM users LIMIT 10',
      async () => {
        // Your actual DB query here
        return [{ id: 1, name: 'John' }, { id: 2, name: 'Jane' }];
      }
    );

    // Track business metric
    watcher.track('api.users.fetched', {
      count: users.length,
      endpoint: '/api/users'
    });

    res.json(users);
  } catch (error) {
    // Auto-captured by middleware, but you can add context
    watcher.captureException(error, {
      endpoint: '/api/users',
      userId: req.query.userId
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/orders', async (req, res) => {
  try {
    const { userId, items, total } = req.body;

    // Track business event
    watcher.track('order.created', {
      userId,
      itemCount: items.length,
      total,
      value: total // For revenue tracking
    });

    // Simulate order processing
    const order = { id: Date.now(), userId, items, total };

    res.json(order);
  } catch (error) {
    watcher.captureException(error, {
      action: 'create_order',
      userId: req.body.userId
    });
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  watcher.captureException(err, {
    path: req.path,
    method: req.method
  });
  res.status(500).json({ error: 'Something went wrong' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  watcher.start();
  console.log(`Server running on port ${PORT}`);
  console.log(`WatchFn dashboard: http://localhost:${PORT}/watch`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  watcher.stop();
  process.exit(0);
});
