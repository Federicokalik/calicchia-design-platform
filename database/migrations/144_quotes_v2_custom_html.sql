-- 144: Custom HTML quotes — hand-crafted quote documents uploaded as-is.
-- The HTML lives in the private file store (like PDFs); this column holds
-- its category/name reference. When set, PDF generation renders the custom
-- document directly instead of the shared Swiss-editorial template.

ALTER TABLE quotes_v2
  ADD COLUMN IF NOT EXISTS custom_html_path TEXT;

COMMENT ON COLUMN quotes_v2.custom_html_path IS 'Private-store reference (quotes/<name>.html) of a hand-crafted quote document; bypasses the shared PDF template';
