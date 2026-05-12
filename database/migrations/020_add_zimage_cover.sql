-- ============================================
-- Add Z-Image (kie.ai) as cover provider
-- ============================================

-- Update cover_provider check constraint to include 'zimage'
ALTER TABLE blog_generation_config
DROP CONSTRAINT IF EXISTS blog_generation_config_cover_provider_check;

ALTER TABLE blog_generation_config
ADD CONSTRAINT blog_generation_config_cover_provider_check
CHECK (cover_provider IN ('none', 'dalle', 'unsplash', 'zimage'));

-- Add zimage_model column for Z-Image model selection
ALTER TABLE blog_generation_config
ADD COLUMN IF NOT EXISTS zimage_model TEXT DEFAULT 'z-image-turbo';

-- Add comment for clarity
COMMENT ON COLUMN blog_generation_config.zimage_model IS 'Z-Image (kie.ai) model: z-image-turbo or z-image-ultra';
