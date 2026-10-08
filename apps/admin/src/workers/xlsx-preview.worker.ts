// Parses client-uploaded XLSX off the main thread: a big workbook can't
// freeze the admin, and SheetJS never touches the admin's own globals.
import { parseXlsxPreview } from '@/lib/xlsx-preview';

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  self.postMessage(parseXlsxPreview(event.data));
};
