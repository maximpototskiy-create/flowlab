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
  subpath: string;  // path inside the category folder ("" at category root), e.g. "EN" or "EN/Promo"
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
  icon: "logo",
  icons: "logo",
  ui: "ui",
  "ui screenshots": "ui",
  store: "store",
  "store screenshots": "store",
  graphic: "graphic",
  graphics: "graphic",
  overlay: "overlay",
  overlays: "overlay",
  music: "music",
  audio: "music",
  sound: "sound",
  sounds: "sound",
  sfx: "sound",
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
// Name match is tolerant: case-insensitive and ignores spaces/_/- so that
// "Cleaner Kit" matches a brand named "CleanerKit".
export async function findBrandFolder(libraryFolderId: string, brandName: string): Promise<string | null> {
  const drive = driveClient();
  const children = await listChildren(drive, libraryFolderId);
  const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, "");
  const target = norm(brandName);
  const match = children.find((f) => f.mimeType === FOLDER_MIME && norm(f.name ?? "") === target);
  return match?.id ?? null;
}

// List immediate subfolders (for diagnostics).
export async function listSubfolderNames(folderId: string): Promise<string[]> {
  const drive = driveClient();
  const children = await listChildren(drive, folderId);
  return children.filter((c) => c.mimeType === FOLDER_MIME).map((c) => c.name ?? "");
}

// Recursively collect media files under a brand folder, tagging each with the
// category inferred from the nearest known category folder on its path.
export async function collectBrandFiles(brandFolderId: string): Promise<DriveFile[]> {
  const drive = driveClient();
  const files: DriveFile[] = [];

  async function walk(folderId: string, inheritedCategory: string, subpath: string): Promise<void> {
    const children = await listChildren(drive, folderId);
    for (const c of children) {
      if (!c.id || !c.name) continue;
      if (c.mimeType === FOLDER_MIME) {
        const mapped = FOLDER_CATEGORY[c.name.trim().toLowerCase()];
        // entering a known category folder resets the subpath; any other folder extends it
        if (mapped) await walk(c.id, mapped, "");
        else await walk(c.id, inheritedCategory, subpath ? `${subpath}/${c.name.trim()}` : c.name.trim());
      } else if (
        (c.mimeType ?? "").startsWith("image/") ||
        (c.mimeType ?? "").startsWith("video/") ||
        (c.mimeType ?? "").startsWith("audio/")
      ) {
        files.push({
          id: c.id,
          name: c.name,
          mimeType: c.mimeType ?? "",
          category: inheritedCategory,
          subpath,
          sizeBytes: c.size ? Number(c.size) : null,
        });
      }
    }
  }

  await walk(brandFolderId, "other", "");
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
