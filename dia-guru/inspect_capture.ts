
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// Load env vars manually since we can't use dotenv easily here
const envPath = path.join(__dirname, 'temp.env.txt');
const envContent = fs.readFileSync(envPath, 'utf-8');
const env: Record<string, string> = {};
envContent.split('\n').forEach(line => {
    const [key, value] = line.split('=');
    if (key && value) env[key.trim()] = value.trim();
});

const supabaseUrl = env['EXPO_PUBLIC_SUPABASE_URL'];
const serviceRole = env['SERVICE_ROLE_KEY'];

if (!supabaseUrl || !serviceRole) {
    console.error("Missing Supabase credentials");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRole);

async function inspectCapture() {
    const captureId = "5d20ff25-1d0a-4e01-aa46-bf03b46fe696";
    const { data, error } = await supabase
        .from('capture_entries')
        .select('*')
        .eq('id', captureId)
        .single();

    if (error) {
        console.error("Error fetching capture:", error);
    } else {
        console.log(JSON.stringify(data, null, 2));
    }
}

inspectCapture();
