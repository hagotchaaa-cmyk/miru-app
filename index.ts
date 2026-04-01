// ─────────────────────────────────────────────────────────────
//  Miru — stripe-webhook/index.ts
//  Listens for Stripe events and updates is_premium in Supabase
//
//  Required environment variables (set in Supabase Dashboard →
//  Edge Functions → stripe-webhook → Secrets):
//    STRIPE_SECRET_KEY      — your Stripe secret key
//    STRIPE_WEBHOOK_SECRET  — from Stripe Dashboard → Webhooks
//    SUPABASE_URL           — auto-provided by Supabase
//    SUPABASE_SERVICE_ROLE_KEY — auto-provided by Supabase
// ─────────────────────────────────────────────────────────────

import Stripe from 'https://esm.sh/stripe@14?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-04-10',
  httpClient: Stripe.createFetchHttpClient(),
});

const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, // service role bypasses RLS
);

Deno.serve(async (req) => {
  // Only accept POST
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    return new Response('Missing stripe-signature header', { status: 400 });
  }

  const body = await req.text();

  // Verify the webhook came from Stripe — never skip this
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      Deno.env.get('STRIPE_WEBHOOK_SECRET')!,
    );
  } catch (err) {
    console.error('[stripe-webhook] Signature verification failed:', err);
    return new Response(`Webhook verification failed: ${err}`, { status: 400 });
  }

  console.log('[stripe-webhook] Received event:', event.type);

  try {
    switch (event.type) {

      // ── Payment succeeded / subscription activated ──────────
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.supabase_user_id;

        if (!userId) {
          console.error('[stripe-webhook] No supabase_user_id in metadata');
          break;
        }

        const { error } = await sb
          .from('profiles')
          .update({
            is_premium:           true,
            stripe_customer_id:   session.customer as string,
            stripe_subscription_id: session.subscription as string,
          })
          .eq('user_id', userId);

        if (error) console.error('[stripe-webhook] Update error:', error.message);
        else console.log('[stripe-webhook] Granted premium to:', userId);
        break;
      }

      // ── Subscription renewed ────────────────────────────────
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;

        const { error } = await sb
          .from('profiles')
          .update({ is_premium: true })
          .eq('stripe_customer_id', customerId);

        if (error) console.error('[stripe-webhook] Renewal error:', error.message);
        else console.log('[stripe-webhook] Renewed premium for customer:', customerId);
        break;
      }

      // ── Payment failed ──────────────────────────────────────
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;

        // Don't revoke immediately on first failure — Stripe retries
        // Only revoke if subscription moves to past_due/canceled
        console.log('[stripe-webhook] Payment failed for customer:', customerId);
        break;
      }

      // ── Subscription canceled or expired ───────────────────
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = sub.customer as string;

        const { error } = await sb
          .from('profiles')
          .update({ is_premium: false })
          .eq('stripe_customer_id', customerId);

        if (error) console.error('[stripe-webhook] Revoke error:', error.message);
        else console.log('[stripe-webhook] Revoked premium for customer:', customerId);
        break;
      }

      // ── Subscription paused or payment past due ─────────────
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = sub.customer as string;
        const isPremium = sub.status === 'active' || sub.status === 'trialing';

        const { error } = await sb
          .from('profiles')
          .update({ is_premium: isPremium })
          .eq('stripe_customer_id', customerId);

        if (error) console.error('[stripe-webhook] Status update error:', error.message);
        else console.log(`[stripe-webhook] Set is_premium=${isPremium} for:`, customerId);
        break;
      }

      default:
        console.log('[stripe-webhook] Unhandled event type:', event.type);
    }
  } catch (err) {
    console.error('[stripe-webhook] Handler error:', err);
    return new Response('Internal error', { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});