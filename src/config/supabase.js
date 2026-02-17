import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from './env.js';
let supabaseClient = null;
export function getSupabaseClient() {
    if (!supabaseClient) {
        supabaseClient = createClient(env.supabase.url, env.supabase.serviceRoleKey, {
            auth: {
                autoRefreshToken: false,
                persistSession: false,
            },
        });
    }
    return supabaseClient;
}
//# sourceMappingURL=supabase.js.map