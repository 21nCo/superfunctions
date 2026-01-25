import {
  SendfnConfig,
  SendEmailParams,
  EmailTransaction,
  SendSmsParams,
  SmsTransaction,
  SendPushParams,
  PushNotification,
  RegisterDeviceParams,
  DeviceToken,
  EmailTemplate,
  CommunicationEvent,
  SuppressionList,
  Platform
} from './types';
import { SendfnDb, FindEventParams } from './database/sendfn-db';
import { EmailService } from './email/service';
import { AwsSesAdapter } from './email/aws-ses-adapter'; // Just for type or default? No, strictly DI now?
import { TemplateEngine, TemplateRegistry } from './templates/engine';
import { PushService } from './push/service';
import { FcmProvider } from './push/fcm';
import { ApnsProvider } from './push/apns';
import { SmsService } from './sms/service';
import { DeviceTokenManager } from './push/device-manager';
import { EventTracker } from './events/tracker';
import { SuppressionManager, SuppressionCheckResult, AddSuppressionParams } from './suppression/manager';
import { AwsSesWebhookHandler } from './events/webhook-handler';
import { welcomeEmailTemplate, passwordResetTemplate, notificationTemplate } from './templates/defaults';
import { createRouter } from '@superfunctions/http';

export class Sendfn {
  private emailService?: EmailService;
  private smsService?: SmsService;
  private pushService: PushService;
  private eventTracker: EventTracker;
  private suppressionManager: SuppressionManager;
  private templateRegistry: TemplateRegistry;
  private deviceManager: DeviceTokenManager;
  private awsSesWebhookHandler: AwsSesWebhookHandler;
  private db: SendfnDb;
  
  public router: any;

  constructor(private config: SendfnConfig) {
    // Initialize Database Wrapper
    this.db = new SendfnDb(config.database);
    
    // Dependencies
    const templateEngine = new TemplateEngine();
    this.templateRegistry = new TemplateRegistry();
    
    // Register default templates
    this.templateRegistry.register(welcomeEmailTemplate);
    this.templateRegistry.register(passwordResetTemplate);
    this.templateRegistry.register(notificationTemplate);
    
    this.suppressionManager = new SuppressionManager(this.db, {
        enabled: config.options?.suppressionEnabled ?? true
    });
    
    this.eventTracker = new EventTracker(this.db);
    
    this.deviceManager = new DeviceTokenManager(this.db);
    
    // Initialize Email Service if Provider is provided
    if (config.emailProvider) {
        // Initialize provider if needed (though it should be initialized by consumer, maybe we ensure?)
        // The interface has initialize()
        config.emailProvider.initialize().catch(err => console.error("Failed to init email provider", err));

        this.emailService = new EmailService(
            config.emailProvider,
            this.db,
            templateEngine,
            this.templateRegistry,
            config.email || { fromEmail: 'noreply@example.com' } as any, // Only need config if we use defaults inside service
            config.options || {}
        );
    } else if (config.email?.awsSes) {
        // Backwards compatibility / ease of use: if awsSes config present but no provider passed, create default
        const provider = new AwsSesAdapter(config.email.awsSes);
        this.emailService = new EmailService(
            provider,
            this.db,
            templateEngine,
            this.templateRegistry,
            config.email,
            config.options || {}
        );
    }
    
    // Initialize SMS Service if Provider is provided
    if (config.smsProvider) {
        config.smsProvider.initialize().catch(err => console.error("Failed to init sms provider", err));
        
        this.smsService = new SmsService(
            config.smsProvider,
            this.db,
            config.options || {}
        );
    }

    // Initialize Push Providers
    const pushProviders = new Map<Platform, any>();
    if (config.push?.providers.fcm) {
        pushProviders.set('android', new FcmProvider(config.push.providers.fcm));
        pushProviders.set('web', new FcmProvider(config.push.providers.fcm)); 
    }
    if (config.push?.providers.apns) {
        pushProviders.set('ios', new ApnsProvider(config.push.providers.apns));
    }
    
    this.pushService = new PushService(
        pushProviders,
        this.db,
        this.deviceManager,
        config.options || {}
    );
    
    this.awsSesWebhookHandler = new AwsSesWebhookHandler(
        this.db,
        this.eventTracker,
        this.suppressionManager
    );
    
    if (config.enableApi) {
        this.initializeRouter();
    }
  }

  private initializeRouter() {
      const adminKey = this.config.apiConfig?.adminKey;
      const adminAuthMiddleware = async (req: Request, _ctx: any, next: () => Promise<Response>) => {
          if (!adminKey) {
             return new Response('Admin API not configured', { status: 401 });
          }
          const authHeader = req.headers.get('authorization');
          const token = authHeader?.replace(/^Bearer\s+/i, '');
          if (token !== adminKey) {
              return new Response('Unauthorized', { status: 401 });
          }
          return next();
      };

      this.router = createRouter({
          middleware: [adminAuthMiddleware],
          routes: [
              // POST /email
              {
                  method: 'POST',
                  path: '/email',
                  handler: async (req, ctx) => {
                      const body = await ctx.json();
                      const result = await this.email(body);
                      return Response.json(result, { status: 201 });
                  }
              },
              // POST /sms
              {
                  method: 'POST',
                  path: '/sms',
                  handler: async (req, ctx) => {
                      const body = await ctx.json();
                      const result = await this.sms(body);
                      return Response.json(result, { status: 201 });
                  }
              },
              // POST /push
              {
                  method: 'POST',
                  path: '/push',
                  handler: async (req, ctx) => {
                      const body = await ctx.json();
                      const result = await this.push(body);
                      return Response.json(result, { status: 201 });
                  }
              },
              // GET /events
              {
                  method: 'GET',
                  path: '/events',
                  handler: async (req, ctx) => {
                      const params = {
                          referenceId: ctx.query.get('referenceId') || undefined,
                          referenceType: ctx.query.get('referenceType') as any || undefined,
                          eventType: ctx.query.get('eventType') || undefined,
                          limit: Number(ctx.query.get('limit')) || 20,
                          offset: Number(ctx.query.get('offset')) || 0,
                      };
                      const events = await this.queryEvents(params);
                      return Response.json({ events });
                  }
              }
          ]
      });
  }

  // Email methods
  async email(params: SendEmailParams): Promise<EmailTransaction> {
    if (!this.emailService) {
        throw new Error("Email provider not configured");
    }
    return this.emailService.sendEmail(params);
  }

  async bulkEmail(recipients: SendEmailParams[]): Promise<EmailTransaction[]> {
    if (!this.emailService) {
        throw new Error("Email provider not configured");
    }
    return this.emailService.sendBulkEmail(recipients);
  }

  // SMS methods
  async sms(params: SendSmsParams): Promise<SmsTransaction> {
      if (!this.smsService) {
          throw new Error("SMS provider not configured");
      }
      return this.smsService.sendSms(params);
  }

  // Push methods
  async push(params: SendPushParams): Promise<PushNotification> {
    return this.pushService.sendPush(params);
  }

  async bulkPush(notifications: SendPushParams[]): Promise<PushNotification[]> {
    return this.pushService.sendBulkPush(notifications);
  }

  // Device management
  async registerDevice(params: RegisterDeviceParams): Promise<DeviceToken> {
    return this.deviceManager.registerDevice(params);
  }

  async getDevices(
    userId: string,
    platform?: Platform
  ): Promise<DeviceToken[]> {
    return this.deviceManager.getActiveDevices(userId, platform);
  }

  async deactivateDevice(token: string): Promise<void> {
    return this.deviceManager.deactivateTokens([token]);
  }

  // Template management
  async registerTemplate(template: EmailTemplate): Promise<void> {
    this.templateRegistry.register(template);
  }

  async getTemplate(templateId: string): Promise<EmailTemplate | undefined> {
    return this.templateRegistry.get(templateId);
  }

  async listTemplates(): Promise<EmailTemplate[]> {
    return this.templateRegistry.list();
  }

  // Event queries
  async getEmailEvents(transactionId: string): Promise<CommunicationEvent[]> {
    return this.eventTracker.getEvents(transactionId, "email");
  }

  async getPushEvents(notificationId: string): Promise<CommunicationEvent[]> {
    return this.eventTracker.getEvents(notificationId, "push");
  }

  async getSmsEvents(transactionId: string): Promise<CommunicationEvent[]> {
      return this.eventTracker.getEvents(transactionId, "sms");
  }

  async queryEvents(params: FindEventParams): Promise<CommunicationEvent[]> {
    return this.eventTracker.queryEvents(params);
  }

  // Suppression management
  async checkSuppressionList(email: string): Promise<SuppressionCheckResult> {
    return this.suppressionManager.checkSuppression(email);
  }

  async addToSuppressionList(
    params: AddSuppressionParams
  ): Promise<SuppressionList> {
    return this.suppressionManager.addToSuppressionList(params);
  }

  async removeFromSuppressionList(email: string): Promise<void> {
    return this.suppressionManager.removeFromSuppressionList(email);
  }

  // Webhooks
  getWebhookHandlers() {
    return {
      awsSes: this.awsSesWebhookHandler,
    };
  }
}

export function sendfn(config: SendfnConfig): Sendfn {
  return new Sendfn(config);
}
