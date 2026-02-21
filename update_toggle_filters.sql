-- ==========================================
-- Fix: Implement Strict AND Logic for Toggle Filters
-- Date: 2026-02-20
-- Description: Updates get_model_previews to strictly use logical AND for 
-- (verified, weights, demo, atlas) filters and accurately handle empty strings.
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
      -- Verified Filter (Strict AND)
      (COALESCE((v_safe_filters->>'verified')::boolean, false) = false OR pm.is_verified = true)
      
      -- Atlas Filter (Strict AND)
      AND (COALESCE((v_safe_filters->>'atlas')::boolean, false) = false OR (
          NULLIF(TRIM(pm.atlas_link_extracted), '') IS NOT NULL
      ))
      
      -- Weights Filter (Strict AND)
      AND (COALESCE((v_safe_filters->>'weights')::boolean, false) = false OR (
          pm.repo_weights_val ILIKE 'yes' 
          OR pm.repo_weights_val = 'true'
      ))
      
      -- Demo Filter (Strict AND, preventing empty strings from registering as demos)
      AND (COALESCE((v_safe_filters->>'demo')::boolean, false) = false OR (
         NULLIF(TRIM(pm.demo_link_repo), '') IS NOT NULL OR
         NULLIF(TRIM(pm.demo_link_model), '') IS NOT NULL OR
         NULLIF(TRIM(pm.demo_link_root), '') IS NOT NULL
      ))
      
      -- Modalities (Keep as original AND)
      AND (
          jsonb_array_length(COALESCE(v_safe_filters->'modalities', '[]')) = 0 OR 
          EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_safe_filters->'modalities') f WHERE f = ANY(ARRAY(SELECT jsonb_array_elements_text(pm.indexing_content))))
      )
      
      -- Specialties (Keep as original AND)
      AND (
          jsonb_array_length(COALESCE(v_safe_filters->'specialties', '[]')) = 0 OR 
          EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_safe_filters->'specialties') f WHERE f = ANY(ARRAY(SELECT jsonb_array_elements_text(pm.indexing_content))))
      )
      
      -- Uses (Keep as original AND)
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
