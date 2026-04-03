import Stripe from "https://esm.sh/stripe@16.10.0?target=deno";

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ ok: false, error: "Method not allowed" }),
        {
          status: 405,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const stripeApiKey = Deno.env.get("STRIPE_API_KEY");
    if (!stripeApiKey) {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing STRIPE_API_KEY" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const stripe = new Stripe(stripeApiKey, {
      apiVersion: "2024-06-20",
    });

    const { userId, email } = await req.json();

    if (!userId) {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing userId" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const origin = req.headers.get("origin") || "http://localhost:3000";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      client_reference_id: userId,
      customer_email: email || undefined,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "Miru Premium Test",
            },
            unit_amount: 399,
          },
          quantity: 1,
        },
      ],
      success_url: `${origin}/premium.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/premium.html?checkout=cancel`,
    });

    return new Response(
      JSON.stringify({ ok: true, url: session.url }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});