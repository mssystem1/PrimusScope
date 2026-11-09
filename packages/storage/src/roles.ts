import type { SqlClient } from './postgres';
import { StorageError } from './errors';

/** Admin-only bootstrap. Values travel as SQL parameters, never SQL literals in logs. */
export async function configureRuntimeRoles(client: SqlClient, webPassword: string, workerPassword: string) {
  if (![webPassword, workerPassword].every(value => /^[A-Za-z0-9_-]{40,80}$/.test(value))
    || webPassword === workerPassword) throw new StorageError('INVALID_RUNTIME_CREDENTIALS');
  await client.query(`CREATE OR REPLACE FUNCTION primusscope.configure_runtime_roles(web_password text, worker_password text)
    RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $function$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='primusscope_web') THEN
        CREATE ROLE primusscope_web LOGIN NOINHERIT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='primusscope_worker') THEN
        CREATE ROLE primusscope_worker LOGIN NOINHERIT;
      END IF;
      EXECUTE format('ALTER ROLE primusscope_web PASSWORD %L', web_password);
      EXECUTE format('ALTER ROLE primusscope_worker PASSWORD %L', worker_password);
      REVOKE ALL ON ALL TABLES IN SCHEMA primusscope FROM primusscope_web,primusscope_worker;
      GRANT USAGE ON SCHEMA primusscope TO primusscope_web,primusscope_worker;
      GRANT SELECT ON primusscope.publication TO primusscope_web;
      GRANT SELECT,INSERT,UPDATE,DELETE ON primusscope.publication,primusscope.collector_lease TO primusscope_worker;
    END $function$`);
  try {
    await client.query('REVOKE ALL ON FUNCTION primusscope.configure_runtime_roles(text,text) FROM PUBLIC');
    await client.query('SELECT primusscope.configure_runtime_roles($1,$2)', [webPassword, workerPassword]);
  } finally {
    await client.query('DROP FUNCTION IF EXISTS primusscope.configure_runtime_roles(text,text)');
  }
}
