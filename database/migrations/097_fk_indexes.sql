-- 097_fk_indexes.sql
-- Covering indexes for foreign-key columns (finding DB-05).
-- Without these, ON DELETE CASCADE and JOINs on the FK do sequential scans.
-- CREATE INDEX IF NOT EXISTS is idempotent — safe under the current re-running
-- migration runner.

CREATE INDEX IF NOT EXISTS idx_ai_actions_log_conversation_id ON ai_actions_log(conversation_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_created_by ON api_keys(created_by);
CREATE INDEX IF NOT EXISTS idx_blog_post_revisions_created_by ON blog_post_revisions(created_by);
CREATE INDEX IF NOT EXISTS idx_blog_posts_author_id ON blog_posts(author_id);
CREATE INDEX IF NOT EXISTS idx_calendar_bookings_contact_id ON calendar_bookings(contact_id);
CREATE INDEX IF NOT EXISTS idx_calendar_bookings_lead_id ON calendar_bookings(lead_id);
CREATE INDEX IF NOT EXISTS idx_client_projects_subscription_id ON client_projects(subscription_id);
CREATE INDEX IF NOT EXISTS idx_communication_preferences_updated_by ON communication_preferences(updated_by);
CREATE INDEX IF NOT EXISTS idx_content_versions_created_by ON content_versions(created_by);
CREATE INDEX IF NOT EXISTS idx_customer_users_invited_by ON customer_users(invited_by);
CREATE INDEX IF NOT EXISTS idx_customers_lead_id ON customers(lead_id);
CREATE INDEX IF NOT EXISTS idx_domain_renewals_invoice_id ON domain_renewals(invoice_id);
CREATE INDEX IF NOT EXISTS idx_domains_subscription_id ON domains(subscription_id);
CREATE INDEX IF NOT EXISTS idx_email_drafts_account_id ON email_drafts(account_id);
CREATE INDEX IF NOT EXISTS idx_email_drafts_reply_to_message_id ON email_drafts(reply_to_message_id);
CREATE INDEX IF NOT EXISTS idx_expenses_linked_invoice_id ON expenses(linked_invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoices_created_by ON invoices(created_by);
CREATE INDEX IF NOT EXISTS idx_invoices_project_id ON invoices(project_id);
CREATE INDEX IF NOT EXISTS idx_invoices_quote_id ON invoices(quote_id);
CREATE INDEX IF NOT EXISTS idx_invoices_subscription_id ON invoices(subscription_id);
CREATE INDEX IF NOT EXISTS idx_leads_converted_customer_id ON leads(converted_customer_id);
CREATE INDEX IF NOT EXISTS idx_leads_converted_project_id ON leads(converted_project_id);
CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_quote_id ON marketing_campaigns(quote_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_created_by ON mcp_tokens(created_by);
CREATE INDEX IF NOT EXISTS idx_media_uploaded_by ON media(uploaded_by);
CREATE INDEX IF NOT EXISTS idx_note_links_target_note_id ON note_links(target_note_id);
CREATE INDEX IF NOT EXISTS idx_payment_receipts_invoice_id ON payment_receipts(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payment_receipts_schedule_id ON payment_receipts(schedule_id);
CREATE INDEX IF NOT EXISTS idx_payment_records_recorded_by ON payment_records(recorded_by);
CREATE INDEX IF NOT EXISTS idx_payment_tracker_project_id ON payment_tracker(project_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice_id ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_subscription_id ON payments(subscription_id);
CREATE INDEX IF NOT EXISTS idx_portal_invites_customer_id ON portal_invites(customer_id);
CREATE INDEX IF NOT EXISTS idx_portal_invites_invited_by ON portal_invites(invited_by);
CREATE INDEX IF NOT EXISTS idx_portal_reports_project_id ON portal_reports(project_id);
CREATE INDEX IF NOT EXISTS idx_project_comments_user_id ON project_comments(user_id);
CREATE INDEX IF NOT EXISTS idx_project_files_task_id ON project_files(task_id);
CREATE INDEX IF NOT EXISTS idx_project_files_uploaded_by ON project_files(uploaded_by);
CREATE INDEX IF NOT EXISTS idx_project_revisions_created_by ON project_revisions(created_by);
CREATE INDEX IF NOT EXISTS idx_quotes_converted_invoice_id ON quotes(converted_invoice_id);
CREATE INDEX IF NOT EXISTS idx_quotes_created_by ON quotes(created_by);
CREATE INDEX IF NOT EXISTS idx_quotes_parent_quote_id ON quotes(parent_quote_id);
CREATE INDEX IF NOT EXISTS idx_quotes_project_id ON quotes(project_id);
CREATE INDEX IF NOT EXISTS idx_quotes_v2_lead_id ON quotes_v2(lead_id);
CREATE INDEX IF NOT EXISTS idx_quotes_v2_project_id ON quotes_v2(project_id);
CREATE INDEX IF NOT EXISTS idx_related_posts_cache_related_post_id ON related_posts_cache(related_post_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_service_id ON subscriptions(service_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_invoice_id ON time_entries(invoice_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_created_by ON webhooks(created_by);
CREATE INDEX IF NOT EXISTS idx_website_projects_quote_id ON website_projects(quote_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_ai_draft_approved_by ON whatsapp_messages(ai_draft_approved_by);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_sender_user_id ON whatsapp_messages(sender_user_id);
