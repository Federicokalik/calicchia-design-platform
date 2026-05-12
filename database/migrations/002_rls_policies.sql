-- =============================================
-- ROW LEVEL SECURITY POLICIES
-- =============================================

-- Abilita RLS su tutte le tabelle
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experiences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media ENABLE ROW LEVEL SECURITY;

-- =============================================
-- HELPER FUNCTION: Check if user is admin
-- =============================================
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================
-- POLICIES: profiles
-- =============================================
DROP POLICY IF EXISTS "Profiles are viewable by everyone" ON public.profiles;
CREATE POLICY "Profiles are viewable by everyone" ON public.profiles
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);

DROP POLICY IF EXISTS "Admins can do everything on profiles" ON public.profiles;
CREATE POLICY "Admins can do everything on profiles" ON public.profiles
  FOR ALL USING (is_admin());

-- =============================================
-- POLICIES: projects
-- =============================================
DROP POLICY IF EXISTS "Published projects are viewable by everyone" ON public.projects;
CREATE POLICY "Published projects are viewable by everyone" ON public.projects
  FOR SELECT USING (is_published = true);

DROP POLICY IF EXISTS "Admins can do everything on projects" ON public.projects;
CREATE POLICY "Admins can do everything on projects" ON public.projects
  FOR ALL USING (is_admin());

-- =============================================
-- POLICIES: blog_posts
-- =============================================
DROP POLICY IF EXISTS "Published posts are viewable by everyone" ON public.blog_posts;
CREATE POLICY "Published posts are viewable by everyone" ON public.blog_posts
  FOR SELECT USING (is_published = true);

DROP POLICY IF EXISTS "Admins can do everything on posts" ON public.blog_posts;
CREATE POLICY "Admins can do everything on posts" ON public.blog_posts
  FOR ALL USING (is_admin());

-- =============================================
-- POLICIES: categories
-- =============================================
DROP POLICY IF EXISTS "Categories are viewable by everyone" ON public.categories;
CREATE POLICY "Categories are viewable by everyone" ON public.categories
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Admins can manage categories" ON public.categories;
CREATE POLICY "Admins can manage categories" ON public.categories
  FOR ALL USING (is_admin());

-- =============================================
-- POLICIES: contacts
-- =============================================
DROP POLICY IF EXISTS "Anyone can insert contacts" ON public.contacts;
CREATE POLICY "Anyone can insert contacts" ON public.contacts
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Admins can view and manage contacts" ON public.contacts;
CREATE POLICY "Admins can view and manage contacts" ON public.contacts
  FOR ALL USING (is_admin());

-- =============================================
-- POLICIES: skills
-- =============================================
DROP POLICY IF EXISTS "Visible skills are viewable by everyone" ON public.skills;
CREATE POLICY "Visible skills are viewable by everyone" ON public.skills
  FOR SELECT USING (is_visible = true);

DROP POLICY IF EXISTS "Admins can manage skills" ON public.skills;
CREATE POLICY "Admins can manage skills" ON public.skills
  FOR ALL USING (is_admin());

-- =============================================
-- POLICIES: experiences
-- =============================================
DROP POLICY IF EXISTS "Visible experiences are viewable by everyone" ON public.experiences;
CREATE POLICY "Visible experiences are viewable by everyone" ON public.experiences
  FOR SELECT USING (is_visible = true);

DROP POLICY IF EXISTS "Admins can manage experiences" ON public.experiences;
CREATE POLICY "Admins can manage experiences" ON public.experiences
  FOR ALL USING (is_admin());

-- =============================================
-- POLICIES: site_settings
-- =============================================
DROP POLICY IF EXISTS "Settings are viewable by everyone" ON public.site_settings;
CREATE POLICY "Settings are viewable by everyone" ON public.site_settings
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Admins can manage settings" ON public.site_settings;
CREATE POLICY "Admins can manage settings" ON public.site_settings
  FOR ALL USING (is_admin());

-- =============================================
-- POLICIES: analytics
-- =============================================
DROP POLICY IF EXISTS "Anyone can insert analytics" ON public.analytics;
CREATE POLICY "Anyone can insert analytics" ON public.analytics
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Admins can view analytics" ON public.analytics;
CREATE POLICY "Admins can view analytics" ON public.analytics
  FOR SELECT USING (is_admin());

-- =============================================
-- POLICIES: media
-- =============================================
DROP POLICY IF EXISTS "Media are viewable by everyone" ON public.media;
CREATE POLICY "Media are viewable by everyone" ON public.media
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Admins can manage media" ON public.media;
CREATE POLICY "Admins can manage media" ON public.media
  FOR ALL USING (is_admin());
