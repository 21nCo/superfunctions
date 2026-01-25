# Sendfn TypeScript SDK

The `sendfn` SDK is a unified communications platform that provides email, SMS, and push notification capabilities. It follows the Superfunctions pattern, utilizing shared database and HTTP abstractions with a modular adapter system for providers.

## Features

- **Unified API**: Send emails, SMS, and push notifications through a single interface.
- **Adapter-Based Providers**: Inject your preferred providers (e.g., AWS SES for email, Console/Twilio for SMS).
- **Built-in API Router**: Optional REST API endpoints for remote management.
- **Template Engine**: Lightweight engine with default templates (Welcome, Password Reset, etc.).
- **Suppression Management**: Built-in handling for email bounces and complaints.
- **Database Agnostic**: Uses `@superfunctions/db` adapters (Drizzle, Prisma, Kysely, etc.).

## Installation

```bash
npm install sendfn @superfunctions/db @superfunctions/http
```

## Quick Start

### 1. Initialize the Client

```typescript
import { sendfn, awsSesAdapter, consoleSmsAdapter } from 'sendfn';
import { drizzleAdapter } from '@superfunctions/db/adapters';

// 1. Setup your shared database adapter
const database = drizzleAdapter({ db, dialect: 'postgres' });

// 2. Initialize sendfn with desired providers
const client = sendfn({
  database,
  emailProvider: awsSesAdapter({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    region: 'us-east-1',
  }),
  smsProvider: consoleSmsAdapter(), // Logs SMS to console for development
  email: {
    fromEmail: 'noreply@yourdomain.com',
    fromName: 'SuperFunctions App',
  },
  enableApi: true,
  apiConfig: {
    adminKey: process.env.SENDFN_ADMIN_KEY,
  },
});
```

### 2. Use the API Router

If `enableApi` is true, the `client.router` instance is available to be mounted on any supported framework via Superfunctions HTTP adapters.

```typescript
import { createExpressApp } from '@superfunctions/http-express';

const app = createExpressApp(client.router);
app.listen(3000);

// Endpoints (Requires 'Authorization: Bearer <adminKey>'):
// POST /email - Send an email
// POST /sms   - Send an SMS
// POST /push  - Send a push notification
// GET  /events - Query communication events
```

## Configuration

```typescript
interface SendfnConfig {
  database: Adapter;           // From @superfunctions/db
  emailProvider?: EmailProvider; // e.g., awsSesAdapter()
  smsProvider?: SmsProvider;     // e.g., consoleSmsAdapter()
  email?: EmailConfig;         // Default settings (fromEmail, fromName)
  push?: PushConfig;           // Credentials for FCM/APNS
  options?: {
    suppressionEnabled?: boolean; // default: true
    eventTracking?: boolean;      // default: true
  };
  enableApi?: boolean;            // default: false
  apiConfig?: {
    adminKey?: string;           // Required if enableApi is true
  };
}
```

## Usage Guide

### Sending Email

```typescript
await client.email({
  userId: 'user-123',
  to: 'user@example.com',
  subject: 'Hello',
  html: '<strong>Welcome to Superfunctions!</strong>',
});
```

### Sending SMS

```typescript
await client.sms({
  userId: 'user-123',
  to: '+1234567890',
  message: 'Your verification code is 554433',
});
```

### Sending Push Notifications

```typescript
// Register a device token for a user
await client.registerDevice({
  userId: 'user-123',
  token: 'fcm-token-xyz',
  platform: 'android',
});

// Send push to all active devices of the user
await client.push({
  userId: 'user-123',
  title: 'Alert',
  body: 'Something happened!',
});
```

### AWS SES Webhooks

To handle bounces and complaints automatically, mount the webhook handler:

```typescript
app.post('/webhooks/ses', async (req, res) => {
  const handler = client.getWebhookHandlers().awsSes;
  // req.body should be the SNS notification JSON
  await handler.handleSnsNotification(req.body);
  res.sendStatus(200);
});
```

## Database Schema

The database adapter expects the following models to be present in your database:

- `email_transactions`
- `sms_transactions`
- `push_notifications`
- `device_tokens`
- `suppression_list`
- `communication_events`

## License

MIT
