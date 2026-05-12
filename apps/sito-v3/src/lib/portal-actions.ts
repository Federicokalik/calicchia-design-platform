'use server';

import { revalidatePath } from 'next/cache';
import {
  approveDeliverable,
  postMessage,
  requestRevisions,
  uploadFile,
} from '@/lib/portal-api';

export async function postProjectMessageAction(projectId: string, formData: FormData) {
  const body = String(formData.get('body') ?? '').trim();
  if (!body) return;
  await postMessage(projectId, body);
  revalidatePath(`/clienti/progetti/${projectId}`);
}

export async function uploadPortalFileAction(formData: FormData) {
  await uploadFile(formData);
  revalidatePath('/clienti/file');
  revalidatePath('/clienti/upload');
}

export async function approveDeliverableAction(deliverableId: string, projectId: string) {
  await approveDeliverable(deliverableId);
  revalidatePath(`/clienti/progetti/${projectId}`);
}

export async function requestRevisionsAction(
  deliverableId: string,
  projectId: string,
  formData: FormData
) {
  const notes = String(formData.get('notes') ?? '').trim();
  if (!notes) return;
  await requestRevisions(deliverableId, notes);
  revalidatePath(`/clienti/progetti/${projectId}`);
}
