import { Hono } from 'hono';
import { mailAccounts } from './accounts';
import { mailMessages } from './messages';
import { mailSend } from './send';
import { mailSync } from './sync';
import { mailLinks } from './links';
import { mailRules } from './rules';
import { mailDrafts } from './drafts';

export const mail = new Hono();

mail.route('/accounts', mailAccounts);
mail.route('/messages', mailMessages);
mail.route('/send', mailSend);
mail.route('/sync', mailSync);
mail.route('/links', mailLinks);
mail.route('/rules', mailRules);
mail.route('/drafts', mailDrafts);
