alter table public.capture_entries
add column if not exists extraction_json jsonb null;
