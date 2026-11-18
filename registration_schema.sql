-- Anmol LibMatrix: structured registration fields (also applied automatically when server.js starts)
ALTER TABLE material_users ADD COLUMN IF NOT EXISTS first_name VARCHAR(100);
ALTER TABLE material_users ADD COLUMN IF NOT EXISTS middle_name VARCHAR(100);
ALTER TABLE material_users ADD COLUMN IF NOT EXISTS last_name VARCHAR(100);
ALTER TABLE material_users ADD COLUMN IF NOT EXISTS state VARCHAR(100);
ALTER TABLE material_users ADD COLUMN IF NOT EXISTS district VARCHAR(100);
ALTER TABLE material_users ADD COLUMN IF NOT EXISTS block VARCHAR(100);
ALTER TABLE material_users ADD COLUMN IF NOT EXISTS pincode VARCHAR(6);
ALTER TABLE material_user_requests ADD COLUMN IF NOT EXISTS first_name VARCHAR(100);
ALTER TABLE material_user_requests ADD COLUMN IF NOT EXISTS middle_name VARCHAR(100);
ALTER TABLE material_user_requests ADD COLUMN IF NOT EXISTS last_name VARCHAR(100);
ALTER TABLE material_user_requests ADD COLUMN IF NOT EXISTS state VARCHAR(100);
ALTER TABLE material_user_requests ADD COLUMN IF NOT EXISTS district VARCHAR(100);
ALTER TABLE material_user_requests ADD COLUMN IF NOT EXISTS block VARCHAR(100);
ALTER TABLE material_user_requests ADD COLUMN IF NOT EXISTS pincode VARCHAR(6);
UPDATE material_users SET first_name = split_part(btrim(name), ' ', 1), last_name = CASE WHEN position(' ' in btrim(name)) > 0 THEN substring(btrim(name) from '[^ ]+$') ELSE '' END, middle_name = CASE WHEN array_length(string_to_array(btrim(name), ' '), 1) > 2 THEN btrim(substring(btrim(name) from '^[^ ]+ +(.*) +[^ ]+$')) ELSE '' END WHERE first_name IS NULL AND name IS NOT NULL;
UPDATE material_user_requests SET first_name = split_part(btrim(name), ' ', 1), last_name = CASE WHEN position(' ' in btrim(name)) > 0 THEN substring(btrim(name) from '[^ ]+$') ELSE '' END, middle_name = CASE WHEN array_length(string_to_array(btrim(name), ' '), 1) > 2 THEN btrim(substring(btrim(name) from '^[^ ]+ +(.*) +[^ ]+$')) ELSE '' END WHERE first_name IS NULL AND name IS NOT NULL;
