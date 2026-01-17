import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { goldskyWebhookHandler } from '../../services/goldsky-webhook-handler';
import { GoldskyWebhookPayload } from '../../types/goldsky';

const router = Router();

// Get webhook secret from environment
const GOLDSKY_WEBHOOK_SECRET = process.env.GOLDSKY_WEBHOOK_SECRET;

/**
 * Verify webhook signature from Goldsky
 * Goldsky signs webhooks with HMAC-SHA256
 */
function verifyWebhookSignature(
  payload: string,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature) {
    return false;
  }

  // Goldsky sends signature in format: "sha256=<hash>"
  const expectedSignature = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')}`;

  // Use timing-safe comparison to prevent timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

/**
 * POST /api/goldsky/webhook
 *
 * Main webhook endpoint for receiving events from Goldsky
 * Processes position changes and pool updates in real-time
 */
router.post('/webhook', async (req: Request, res: Response) => {
  try {
    // Verify webhook signature if secret is configured
    if (GOLDSKY_WEBHOOK_SECRET) {
      const rawBody = JSON.stringify(req.body);
      const signature = req.headers['x-goldsky-signature'] as string | undefined;

      if (!verifyWebhookSignature(rawBody, signature, GOLDSKY_WEBHOOK_SECRET)) {
        console.error('❌ Invalid webhook signature');
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid webhook signature',
        });
      }
    } else {
      console.warn('⚠️  GOLDSKY_WEBHOOK_SECRET not configured - webhook is not authenticated!');
    }

    const payload: GoldskyWebhookPayload = req.body;

    // Validate payload structure
    if (!payload.events || !Array.isArray(payload.events)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid webhook payload: missing events array',
      });
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`📥 GOLDSKY WEBHOOK RECEIVED`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Timestamp: ${payload.timestamp || new Date().toISOString()}`);
    console.log(`Network: ${payload.network || 'unknown'}`);
    console.log(`Events: ${payload.events.length}`);
    console.log(`${'='.repeat(60)}\n`);

    // Process webhook asynchronously
    const result = await goldskyWebhookHandler.processWebhook(payload);

    // Return response immediately
    return res.status(200).json({
      success: result.success,
      message: 'Webhook processed',
      summary: {
        events_received: result.events_received,
        positions_processed: result.positions_processed,
        pools_processed: result.pools_processed,
        configs_processed: result.configs_processed,
        total_inserted: result.positions_inserted + result.pools_inserted,
        total_updated: result.positions_updated + result.pools_updated,
        errors: result.errors.length,
      },
    });
  } catch (error) {
    console.error('❌ Webhook processing error:', error);

    return res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/goldsky/status
 *
 * Health check endpoint for Goldsky webhook
 */
router.get('/status', (req: Request, res: Response) => {
  const hasSecret = !!GOLDSKY_WEBHOOK_SECRET;

  res.json({
    status: 'operational',
    webhook_url: '/api/goldsky/webhook',
    authentication: hasSecret ? 'enabled' : 'disabled',
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /api/goldsky/test
 *
 * Test endpoint to simulate a webhook (for development/testing)
 * Only available in non-production environments
 */
router.post('/test', async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Test endpoint not available in production',
    });
  }

  try {
    const testPayload: GoldskyWebhookPayload = req.body;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🧪 TEST WEBHOOK (Not from Goldsky)`);
    console.log(`${'='.repeat(60)}\n`);

    const result = await goldskyWebhookHandler.processWebhook(testPayload);

    return res.status(200).json({
      success: result.success,
      message: 'Test webhook processed',
      result,
    });
  } catch (error) {
    console.error('❌ Test webhook error:', error);

    return res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
