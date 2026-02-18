-- Fix: Restore safe_json_parse, Ensure Schema Exists, and Optimize get_model_previews
-- Date: 2026-02-18
-- Description: Full comprehensive fix.
-- 1. Ensures 'model_likes' table and 'models.likes_count' column exist.
-- 2. Restores robust 'safe_json_parse'.
-- 3. Updates 'get_model_previews' to use safe parsing and efficient filtering.

-- ==========================================
-- 1. Schema & Permissions (Idempotent)
-- ==========================================

-- Create Table `model_likes` if not exists
CREATE TABLE IF NOT EXISTS public.model_likes (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    model_id UUID REFERENCES public.models(id) ON DELETE CASCADE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, model_id)
);

-- Add `likes_count` to `models` if not exists
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='likes_count') THEN 
        ALTER TABLE public.models ADD COLUMN likes_count INT DEFAULT 0; 
    END IF; 
END $$;

-- Enable RLS
ALTER TABLE public.model_likes ENABLE ROW LEVEL SECURITY;

-- Re-apply policies (Idempotent: drop then create)
DROP POLICY IF EXISTS "Users can insert their own likes" ON public.model_likes;
DROP POLICY IF EXISTS "Users can delete their own likes" ON public.model_likes;
DROP POLICY IF EXISTS "Users can view their own likes" ON public.model_likes;

CREATE POLICY "Users can insert their own likes" ON public.model_likes 
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own likes" ON public.model_likes 
    FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Users can view their own likes" ON public.model_likes 
    FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- Update Trigger for likes_count
CREATE OR REPLACE FUNCTION public.update_model_likes_count()
RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'INSERT') THEN
        UPDATE public.models SET likes_count = likes_count + 1 WHERE id = NEW.model_id;
        RETURN NEW;
    ELSIF (TG_OP = 'DELETE') THEN
        UPDATE public.models SET likes_count = GREATEST(0, likes_count - 1) WHERE id = OLD.model_id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_model_like_change ON public.model_likes;
CREATE TRIGGER on_model_like_change
AFTER INSERT OR DELETE ON public.model_likes
FOR EACH ROW EXECUTE FUNCTION public.update_model_likes_count();


-- ==========================================
-- 2. Helper: Robust JSON Parser (The Fix)
-- ==========================================
CREATE OR REPLACE FUNCTION safe_json_parse(data_input text)
RETURNS jsonb AS $$
DECLARE
  j jsonb;
  t text;
BEGIN
  BEGIN
    j := data_input::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;

  -- Check if the result is a string (double-encoded JSON)
  IF jsonb_typeof(j) = 'string' THEN
    t := j #>> '{}';
    BEGIN
      -- If the inner string looks like an Object or Array, parse it
      IF t LIKE '{%' OR t LIKE '[%' THEN
        RETURN t::jsonb;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RETURN NULL;
    END;
  END IF;

  RETURN j;
END;
$$ LANGUAGE plpgsql IMMUTABLE;


-- ==========================================
-- 3. get_model_previews (Optimized & Safe)
-- ==========================================
CREATE OR REPLACE FUNCTION get_model_previews(
  p_page int DEFAULT 1,
  p_page_size int DEFAULT 20,
  p_search text DEFAULT NULL,
  p_filters jsonb DEFAULT '{}'::jsonb,
  p_sort text DEFAULT 'likes',
  p_liked_by_user uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  created_at timestamptz,
  is_verified boolean,
  likes_count int,     
  preview_data jsonb,
  total_count bigint
) AS $$
DECLARE
  v_page int := GREATEST(COALESCE(p_page, 1), 1);
  v_offset int := (v_page - 1) * p_page_size;
  v_safe_filters jsonb := COALESCE(p_filters, '{}'::jsonb);
BEGIN

  RETURN QUERY
  WITH processed_models AS (
    SELECT 
      m.id,
      m.created_at,
      m.verification_date,
      m.is_verified,
      m.likes_count,
      -- FIX: Perform Search FILTER HERE on raw text for performance
      -- This avoids parsing huge JSONs if they don't match the search anyway
      m.card_data::text as raw_text,
      safe_json_parse(m.card_data::text) as j_data
    FROM models m
    WHERE (m.card_data IS NOT NULL)
      -- Dashboard Filter
      AND (p_liked_by_user IS NULL OR EXISTS (
          SELECT 1 FROM public.model_likes ml WHERE ml.model_id = m.id AND ml.user_id = p_liked_by_user
      ))
      -- OPTIMIZATION: Early Search Filter on Raw Text
      AND (p_search IS NULL OR p_search = '' OR m.card_data::text ILIKE '%' || p_search || '%')
  ),
  valid_models AS (
    SELECT 
      pm.*,
      COALESCE(j_data #>> '{Model, atlas_link}', j_data #>> '{atlas_link}') as atlas_link_extracted,
      j_data #>> '{Model, Name}' as model_name,
      j_data #>> '{Model, Model properties, repository_analysis, contains_weights}' as repo_weights_val,
      j_data #>> '{Model, Model properties, repository_analysis, demo_link}' as demo_link_repo,
      j_data #>> '{Model, demo_link}' as demo_link_model,
      j_data #>> '{demo_link}' as demo_link_root,
      COALESCE(j_data #> '{Model, Indexing, Content}', '[]'::jsonb) as indexing_content,
      COALESCE(j_data #> '{Model, Model properties, Use}', '[]'::jsonb) as use_cases
    FROM processed_models pm
    WHERE pm.j_data IS NOT NULL -- Drop rows that failed parsing
      -- Robust Deleted Check
      AND (pm.j_data->>'_deleted' IS NULL OR pm.j_data->>'_deleted' != 'true')
  ),
  filtered_models AS (
    SELECT *
    FROM valid_models pm
    WHERE 
      -- Search (Already done in CTE, but keeping as safety or for parsed-only fields if needed, 
      -- though raw text search is usually sufficient and inclusive)
      
      -- Verified
      ((v_safe_filters->>'verified')::boolean IS NOT TRUE OR pm.is_verified = true)
      
      -- Atlas
      AND ((v_safe_filters->>'atlas')::boolean IS NOT TRUE OR (
          pm.atlas_link_extracted IS NOT NULL AND pm.atlas_link_extracted <> '' 
      ))
      
      -- Weights
      AND ((v_safe_filters->>'weights')::boolean IS NOT TRUE OR (
          (pm.repo_weights_val) ILIKE 'yes' 
          OR (pm.repo_weights_val) = 'true'
      ))
      
      -- Demo
      AND ((v_safe_filters->>'demo')::boolean IS NOT TRUE OR (
         (pm.demo_link_repo IS NOT NULL) OR
         (pm.demo_link_model IS NOT NULL) OR
         (pm.demo_link_root IS NOT NULL)
      ))
      
      -- Modalities
      AND (
          jsonb_array_length(COALESCE(v_safe_filters->'modalities', '[]')) = 0 OR 
          EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_safe_filters->'modalities') f WHERE f = ANY(ARRAY(SELECT jsonb_array_elements_text(pm.indexing_content))))
      )
      
      -- Specialties
      AND (
          jsonb_array_length(COALESCE(v_safe_filters->'specialties', '[]')) = 0 OR 
          EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_safe_filters->'specialties') f WHERE f = ANY(ARRAY(SELECT jsonb_array_elements_text(pm.indexing_content))))
      )
      
      -- Uses
      AND (
          jsonb_array_length(COALESCE(v_safe_filters->'uses', '[]')) = 0 OR 
          EXISTS (
               SELECT 1 
               FROM jsonb_array_elements_text(
                   CASE WHEN jsonb_typeof(pm.use_cases) = 'array' THEN pm.use_cases ELSE jsonb_build_array(pm.use_cases) END
               ) u
               WHERE u = ANY(ARRAY(SELECT jsonb_array_elements_text(v_safe_filters->'uses')))
           )
      )
  ),
  total_count_cte AS (
      SELECT COUNT(*) as cnt FROM filtered_models
  )
  SELECT 
    fm.id,
    fm.created_at,
    fm.is_verified,
    fm.likes_count, 
    jsonb_build_object(
        'Model', jsonb_build_object(
            'Name', fm.model_name,
            'Indexing', jsonb_build_object('Content', fm.indexing_content),
            'Model properties', jsonb_build_object(
                'Use', fm.use_cases,
                'Indications for use', fm.j_data #>> '{Model, Model properties, Indications for use}',
                'Validation', fm.j_data #>> '{Model, Model properties, Validation}',
                'repository_analysis', jsonb_build_object(
                    'contains_weights', (fm.repo_weights_val ILIKE 'yes' OR fm.repo_weights_val = 'true'),
                    'demo_link', fm.demo_link_repo
                )
            ),
            'demo_link', fm.demo_link_model,
            'atlas_link', fm.atlas_link_extracted
        ),
        'demo_link', fm.demo_link_root
    ) as preview_data,
    tc.cnt as total_count
  FROM filtered_models fm, total_count_cte tc
  ORDER BY 
    CASE WHEN p_sort = 'likes' THEN fm.likes_count END DESC NULLS LAST,
    COALESCE(fm.verification_date, fm.created_at) DESC,
    (CASE WHEN (fm.atlas_link_extracted IS NOT NULL AND fm.atlas_link_extracted <> '') THEN 1 ELSE 0 END) ASC,
    fm.id DESC
  LIMIT p_page_size
  OFFSET v_offset;
END;
$$ LANGUAGE plpgsql;
