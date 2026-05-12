BEGIN;

DROP INDEX IF EXISTS idx_client_projects_wc_order;

ALTER TABLE IF EXISTS client_projects
  DROP COLUMN IF EXISTS woocommerce_order_id;

DROP FUNCTION IF EXISTS find_or_create_customer_from_wc_order(UUID) CASCADE;
DROP FUNCTION IF EXISTS create_subscription_from_wc_order(UUID) CASCADE;

DROP TABLE IF EXISTS
  woocommerce_webhooks,
  woocommerce_webhook_logs,
  woocommerce_products,
  woocommerce_customers,
  woocommerce_orders,
  woocommerce_stores
CASCADE;

COMMIT;
