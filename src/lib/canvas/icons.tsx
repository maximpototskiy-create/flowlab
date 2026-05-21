"use client";

import {
  Anchor, ArrowRightLeft, AudioLines, BadgeCheck, BellRing, Brush, Clapperboard,
  ClipboardList, Code, Copy, Download, Drama, FileAudio, FileImage, FileSearch,
  FileVideo, Film, ImageDown, ImagePlus, Languages, Layers, Maximize, Megaphone,
  MousePointerClick, Move3d, Monitor, Mic, Music, Music2, NotebookPen, Package,
  Package2, PersonStanding, ScanEye, Scissors, ScrollText, Settings, Smartphone,
  Sparkles, Speech, StickyNote, Type, User, Video, WandSparkles, Webhook, ZoomIn,
  type LucideIcon,
} from "lucide-react";

const MAP: Record<string, LucideIcon> = {
  anchor: Anchor, "arrow-right-left": ArrowRightLeft, "audio-lines": AudioLines,
  "badge-check": BadgeCheck, "bell-ring": BellRing, brush: Brush, clapperboard: Clapperboard,
  "clipboard-list": ClipboardList, code: Code, copy: Copy, download: Download, drama: Drama,
  "file-audio": FileAudio, "file-image": FileImage, "file-search": FileSearch,
  "file-video": FileVideo, film: Film, "image-down": ImageDown, "image-plus": ImagePlus,
  languages: Languages, layers: Layers, maximize: Maximize, megaphone: Megaphone,
  "mouse-pointer-click": MousePointerClick, "move-3d": Move3d, monitor: Monitor, mic: Mic,
  music: Music, "music-2": Music2, "notebook-pen": NotebookPen, package: Package,
  "package-2": Package2, "person-standing": PersonStanding, "scan-eye": ScanEye,
  scissors: Scissors, "scroll-text": ScrollText, settings: Settings, smartphone: Smartphone,
  sparkles: Sparkles, speech: Speech, "sticky-note": StickyNote, type: Type, user: User,
  video: Video, "wand-sparkles": WandSparkles, webhook: Webhook, "zoom-in": ZoomIn,
};

export function NodeIcon({
  name, className = "", size = 14, strokeWidth = 1.5, style,
}: { name: string; className?: string; size?: number; strokeWidth?: number; style?: React.CSSProperties }) {
  const Icon = MAP[name];
  if (!Icon) return null;
  return <Icon className={className} size={size} strokeWidth={strokeWidth} style={style} />;
}

export function hasIcon(name: string): boolean {
  return name in MAP;
}
