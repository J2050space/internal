// Supabase client configuration.
// Only the PUBLIC key (publishable / anon) may appear here.
// NEVER put the secret / service_role key in this file or anywhere in the repository.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://YOUR-PROJECT-ID.supabase.co';
const SUPABASE_KEY = 'YOUR-PUBLISHABLE-OR-ANON-KEY';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
