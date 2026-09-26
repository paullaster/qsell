-- =============================================================================
-- PostgreSQL Extensions for qsell
-- =============================================================================

-- UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Full text search
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- Statistics and monitoring
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";
CREATE EXTENSION IF NOT EXISTS "pg_buffercache";
CREATE EXTENSION IF NOT EXISTS "pg_stat_clear_snapshot";

-- UUID comparison
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Performance
CREATE EXTENSION IF NOT EXISTS "btree_gin";
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- Set up pg_stat_statements
ALTER SYSTEM SET pg_stat_statements.max = 10000;
ALTER SYSTEM SET pg_stat_statements.track = all;
ALTER SYSTEM SET pg_stat_statements.track_utility = off;
ALTER SYSTEM SET pg_stat_statements.save = on;

-- =============================================================================
-- Create Read-Only User for Monitoring/Reporting
-- =============================================================================
-- DO NOT RUN THIS IN PRODUCTION - use separate migration
-- CREATE ROLE qsell_readonly NOLOGIN;
-- GRANT CONNECT ON DATABASE qsell TO qsell_readonly;
-- GRANT USAGE ON SCHEMA public TO qsell_readonly;
-- GRANT SELECT ON ALL TABLES IN SCHEMA public TO qsell_readonly;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO qsell_readonly;
