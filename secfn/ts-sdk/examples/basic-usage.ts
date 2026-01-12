import { createSecFn } from '../src/index.js';

async function main() {
  const secFn = createSecFn({
    namespace: 'my-app-security',
    masterKey: process.env.MASTER_KEY || 'dev-master-key-change-in-production',
  });

  await secFn.initialize();
  console.log('✅ SecFn initialized');

  const vault = secFn.createSecretsVault();
  const scanner = secFn.createSecretScanner();
  const access = secFn.createAccessControl();
  const limiter = secFn.createRateLimiter({
    rules: {
      global: { requests: 1000, window: 60000 },
      perUser: { requests: 100, window: 60000 },
      perIP: { requests: 50, window: 60000 },
      perEndpoint: {
        '/api/login': { requests: 5, window: 300000 },
      },
    },
  });
  const monitoring = secFn.createMonitoring({
    anomalyDetection: {
      enabled: true,
      sensitivity: 0.7,
    },
  });

  console.log('\n📦 Testing Secrets Vault...');
  await vault.set('database_url', 'postgres://user:pass@localhost:5432/db', {
    tags: ['database', 'production'],
    environment: 'production',
    createdBy: 'admin',
  });
  console.log('✓ Secret stored');

  const dbUrl = await vault.get('database_url');
  console.log('✓ Secret retrieved:', dbUrl?.substring(0, 20) + '...');

  const secrets = await vault.list({ environment: 'production' });
  console.log(`✓ Found ${secrets.length} production secrets`);

  console.log('\n🔍 Testing Secret Scanner...');
  const scanResults = scanner.scanContent(
    `
    const apiKey = 'sk-ant-1234567890abcdef';
    const awsKey = 'AKIAIOSFODNN7EXAMPLE';
    const password = 'super-secret-password';
  `,
    'test.ts'
  );
  console.log(`✓ Found ${scanResults.length} secrets in code:`);
  scanResults.forEach(r => {
    console.log(`  - ${r.pattern} at line ${r.line}: ${r.redactedMatch}`);
  });

  console.log('\n🔐 Testing Access Control...');
  const adminRole = await access.createRole({
    name: 'admin',
    description: 'Full system access',
    permissions: ['*:*'],
  });
  console.log('✓ Admin role created');

  const editorRole = await access.createRole({
    name: 'editor',
    description: 'Can edit projects',
    permissions: ['project:read', 'project:write', 'file:read', 'file:write'],
  });
  console.log('✓ Editor role created');

  await access.assignRole('user_123', editorRole);
  console.log('✓ Role assigned to user');

  const canEdit = await access.check({
    userId: 'user_123',
    action: 'project:write',
  });
  console.log(`✓ User can edit projects: ${canEdit}`);

  const canDelete = await access.check({
    userId: 'user_123',
    action: 'project:delete',
  });
  console.log(`✓ User can delete projects: ${canDelete}`);

  console.log('\n⏱️  Testing Rate Limiting...');
  for (let i = 0; i < 3; i++) {
    const result = await limiter.check({
      userId: 'user_456',
      ip: '192.168.1.1',
      endpoint: '/api/search',
    });
    console.log(`  Request ${i + 1}: ${result.allowed ? '✓ Allowed' : '✗ Blocked'} (remaining: ${result.remaining})`);
  }

  console.log('\n📊 Testing Security Monitoring...');
  await monitoring.logEvent({
    type: 'auth_failure',
    severity: 'medium',
    userId: 'user_789',
    ip: '192.168.1.100',
    resource: '/api/login',
    action: 'login',
    metadata: {
      reason: 'invalid_password',
      attemptCount: 3,
    },
  });
  console.log('✓ Security event logged');

  await monitoring.logEvent({
    type: 'permission_denied',
    severity: 'low',
    userId: 'user_789',
    ip: '192.168.1.100',
    resource: '/api/admin',
    action: 'access',
  });
  console.log('✓ Another security event logged');

  const recentEvents = await monitoring.getRecentEvents(10);
  console.log(`✓ Retrieved ${recentEvents.length} recent events`);

  const metrics = await monitoring.getMetrics({
    start: Date.now() - 24 * 60 * 60 * 1000,
    end: Date.now(),
  });
  console.log('✓ Metrics calculated:');
  console.log(`  - Total events: ${metrics.totalEvents}`);
  console.log(`  - Events by type:`, metrics.eventsByType);
  console.log(`  - Events by severity:`, metrics.eventsBySeverity);

  console.log('\n✨ All tests completed successfully!');

  await secFn.destroy();
  console.log('🧹 Cleanup complete');
}

main().catch(console.error);
