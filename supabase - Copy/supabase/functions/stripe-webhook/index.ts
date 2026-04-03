import Stripe from "https://esm.sh/stripe@16.10.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_API_KEY")!, {
  apiVersion: "2024-06-20",
});

const cryptoProvider = Stripe.createSubtleCryptoProvider();

Deno.serve(async (req) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const stripeWebhookSecret = Deno.env.get("STRIPE_WEBHOOK_SIGNING_SECRET");

    if (!supabaseUrl || !serviceRoleKey) {
      console.log("Missing Supabase env vars");
      return new Response(
        JSON.stringify({ ok: false, error: "Missing Supabase env vars" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!stripeWebhookSecret) {
      console.log("Missing Stripe webhook secret");
      return new Response(
        JSON.stringify({ ok: false, error: "Missing Stripe webhook secret" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const signature = req.headers.get("Stripe-Signature");
    console.log("Stripe-Signature present:", !!signature);

    if (!signature) {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing Stripe-Signature header" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const body = await req.text();

    let event: Stripe.Event;

    try {
      event = await stripe.webhooks.constructEventAsync(
        body,
        signature,
        stripeWebhookSecret,
        undefined,
        cryptoProvider
      );
    } catch (err) {
      console.log("Signature verification failed:", err);
      return new Response(
        JSON.stringify({
          ok: false,
          error: `Webhook signature verification failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    console.log("Stripe event type:", event.type);

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const clientReferenceId = session.client_reference_id;

      console.log("Checkout session id:", session.id);
      console.log("client_reference_id:", clientReferenceId);
      console.log("customer_email:", session.customer_email);
      console.log("payment_status:", session.payment_status);

      if (!clientReferenceId) {
        return new Response(
          JSON.stringify({ ok: false, error: "Missing client_reference_id" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const { data, error } = await supabase
        .from("profiles")
        .update({ is_premium: true })
        .eq("user_id", clientReferenceId)
        .select("user_id,name,is_premium");

      console.log("Supabase update data:", data);
      console.log("Supabase update error:", error);

      if (error) {
        return new Response(
          JSON.stringify({ ok: false, error: error.message }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }

      if (!data || data.length === 0) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: "No profile matched client_reference_id",
            client_reference_id: clientReferenceId,
          }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({
          ok: true,
          mode: "stripe",
          event_type: event.type,
          updated: data,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        ignored: true,
        event_type: event.type,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.log("Webhook crash:", err);
    return new Response(
      JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});