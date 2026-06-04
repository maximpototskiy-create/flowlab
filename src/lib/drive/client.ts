// ─────────────────────────────────────────────────────────────────────────
// Google Drive client (service account). Reads a brand's folder in the
// shared "Creative Asset Library" drive and maps its structure to our assets:
//
//   <Brand>/Hooks|Bodies|Packshots/<…>/file   →  category hook|body|packshot
//
// Auth: service-account JSON in env GOOGLE_SERVICE_ACCOUNT_JSON (the whole
// JSON string). Read-only Drive scope. Shared Drives are supported.
// ─────────────────────────────────────────────────────────────────────────
import { google } from "googleapis";
import type { drive_v3 } from "googleapis";

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  category: string; // hook | body | packshot | other
  sizeBytes: number | null;
};

// Folder name (lowercased) → our category.
const FOLDER_CATEGORY: Record<string, string> = {
  hooks: "hook",
  hook: "hook",
  bodies: "body",
  body: "body",
  packshots: "packshot",
  packshot: "packshot",
  logos: "logo",
  logo: "logo",
  ui: "ui",
  references: "reference",
  reference: "reference",
};

function driveClient(): drive_v3.Drive {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");
  const creds = JSON.parse(raw) as { client_email: string; private_key: string };
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  return google.drive({ version: "v3", auth });
}

const LIST_OPTS = {
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
  corpora: "allDrives" as const,
  fields: "nextPageToken, files(id, name, mimeType, size)",
  pageSize: 200,
};

// List immediate children of a folder.
async function listChildren(drive: drive_v3.Drive, folderId: string): Promise<drive_v3.Schema$File[]> {
  const out: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      ...LIST_OPTS,
      q: `'${folderId}' in parents and trashed = false`,
      pageToken,
    });
    out.push(...(res.data.files ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

const FOLDER_MIME = "application/vnd.google-apps.folder";

// Find a brand's folder by name inside the given library folder.
export async function findBrandFolder(libraryFolderId: string, brandName: string): Promise<string | null> {
  const drive = driveClient();
  const children = await listChildren(drive, libraryFolderId);
  const match = children.find(
    (f) => f.mimeType === FOLDER_MIME && (f.name ?? "").trim().toLowerCase() === brandName.trim().toLowerCase(),
  );
  return match?.id ?? null;
}

// Recursively collect media files under a brand folder, tagging each with the
// category inferred from the nearest known category folder on its path.
export async function collectBrandFiles(brandFolderId: string): Promise<DriveFile[]> {
  const drive = driveClient();
  const files: DriveFile[] = [];

  async function walk(folderId: string, inheritedCategory: string): Promise<void> {
    const children = await listChildren(drive, folderId);
    for (const c of children) {
      if (!c.id || !c.name) continue;
      if (c.mimeType === FOLDER_MIME) {
        const mapped = FOLDER_CATEGORY[c.name.trim().toLowerCase()];
        await walk(c.id, mapped ?? inheritedCategory);
      } else if ((c.mimeType ?? "").startsWith("image/") || (c.mimeType ?? "").startsWith("video/")) {
        files.push({
          id: c.id,
          name: c.name,
          mimeType: c.mimeType ?? "",
          category: inheritedCategory,
          sizeBytes: c.size ? Number(c.size) : null,
        });
      }
    }
  }

  await walk(brandFolderId, "other");
  return files;
}

// Download a Drive file's bytes (for re-upload to our storage).
export async function downloadDriveFile(fileId: string): Promise<Buffer> {
  const drive = driveClient();
  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" },
  );
  return Buffer.from(res.data as ArrayBuffer);
}
