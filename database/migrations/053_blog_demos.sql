-- Add demos column to blog_posts for storing interactive code demos
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS demos JSONB DEFAULT '[]'::jsonb;
