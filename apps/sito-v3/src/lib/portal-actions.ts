'use server';

import { revalidatePath } from 'next/cache';
import {
  approveCampaignAsset,
  approveDeliverable,
  postMessage,
  requestCampaignAssetRevision,
  requestRevisions,
  uploadFile,
} from '@/lib/portal-api';

/**
 * Audit N1: server actions that previously called `await fn()` and let any
 * exception bubble up as a generic transition failure. The client UI shows
 * "Messaggio non inviato. Riprova." with no context — for bugs like B-001
 * (collab CHECK violation) the customer had no clue why. Wrap each call so
 * the actual error reaches stderr (server logs / Sentry) before being
 * re-thrown to React.
 */
function logActionError(action: string, projectId: string | undefined, err: unknown) {
  // Server Actions run on the Node side; console.error reaches whatever
  // shipping pipe is in place (Vercel logs, Docker stdout, Sentry's auto
  // capture). Avoid noisy stack traces on user-driven "empty body" returns —
  // we never reach this helper for those (early return above).
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[portal-actions] ${action} failed${projectId ? ` for project ${projectId}` : ''}: ${msg}`);
}

export async function postProjectMessageAction(projectId: string, formData: FormData) {
  const body = String(formData.get('body') ?? '').trim();
  if (!body) return;
  try {
    await postMessage(projectId, body);
  } catch (err) {
    logActionError('postMessage', projectId, err);
    throw err;
  }
  revalidatePath(`/clienti/progetti/${projectId}`);
}

export async function uploadPortalFileAction(formData: FormData) {
  try {
    await uploadFile(formData);
  } catch (err) {
    logActionError('uploadFile', undefined, err);
    throw err;
  }
  revalidatePath('/clienti/file');
  revalidatePath('/clienti/upload');
}

export async function approveDeliverableAction(deliverableId: string, projectId: string) {
  try {
    await approveDeliverable(deliverableId);
  } catch (err) {
    logActionError(`approveDeliverable(${deliverableId})`, projectId, err);
    throw err;
  }
  revalidatePath(`/clienti/progetti/${projectId}`);
}

export async function requestRevisionsAction(
  deliverableId: string,
  projectId: string,
  formData: FormData
) {
  const notes = String(formData.get('notes') ?? '').trim();
  if (!notes) return;
  try {
    await requestRevisions(deliverableId, notes);
  } catch (err) {
    logActionError(`requestRevisions(${deliverableId})`, projectId, err);
    throw err;
  }
  revalidatePath(`/clienti/progetti/${projectId}`);
}

export async function approveCampaignAssetAction(assetId: string, campaignId: string) {
  try {
    await approveCampaignAsset(assetId);
  } catch (err) {
    logActionError(`approveCampaignAsset(${assetId})`, undefined, err);
    throw err;
  }
  revalidatePath('/clienti/campagne');
  revalidatePath(`/clienti/campagne/${campaignId}`);
}

export async function requestCampaignAssetRevisionAction(
  assetId: string,
  campaignId: string,
  formData: FormData,
) {
  const notes = String(formData.get('notes') ?? '').trim();
  if (!notes) return;
  try {
    await requestCampaignAssetRevision(assetId, notes);
  } catch (err) {
    logActionError(`requestCampaignAssetRevision(${assetId})`, undefined, err);
    throw err;
  }
  revalidatePath('/clienti/campagne');
  revalidatePath(`/clienti/campagne/${campaignId}`);
}
