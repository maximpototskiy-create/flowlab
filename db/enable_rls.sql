-- FlowLab: enable Row Level Security on every public table (Supabase Advisor
-- criticals). The app NEVER reads these tables from the browser - all data
-- access goes through Next.js API routes using Prisma, which connects as the
-- table OWNER (postgres role) and therefore BYPASSES RLS. Enabling RLS with
-- NO policies = deny-all for the anon/authenticated PostgREST keys, which is
-- exactly what we want: the anon key ships in the JS bundle, and without RLS
-- anyone holding it could read/write these tables through the auto-generated
-- REST API.
-- Run in Supabase Dashboard -> SQL Editor. Safe to re-run.
ALTER TABLE public.users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brands             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflows          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assets             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brand_kits         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brand_kit_assets   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brand_assets       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_embeddings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.runs               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_steps          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_log          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public._prisma_migrations ENABLE ROW LEVEL SECURITY;
