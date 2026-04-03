import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async (req) => {
  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const authHeader = req.headers.get('Authorization')!
  const token = authHeader.replace('Bearer ', '')
  const { data: { user } } = await supabaseAdmin.auth.getUser(token)

  if (!user) return new Response('Unauthorized', { status: 401 })

  const { error } = await supabaseAdmin.auth.admin.deleteUser(user.id)

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 400 })

  return new Response(JSON.stringify({ success: true }), { status: 200 })
})
