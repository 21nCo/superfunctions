-- Check if todos table exists and its structure
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'todos'
ORDER BY ordinal_position;
