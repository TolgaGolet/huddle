export const AVATAR_COLORS = [
  { bg: "bg-indigo-600",  text: "text-indigo-400"  },
  { bg: "bg-emerald-600", text: "text-emerald-400" },
  { bg: "bg-rose-600",    text: "text-rose-400"    },
  { bg: "bg-amber-600",   text: "text-amber-400"   },
  { bg: "bg-cyan-600",    text: "text-cyan-400"    },
  { bg: "bg-violet-600",  text: "text-violet-400"  },
  { bg: "bg-pink-600",    text: "text-pink-400"    },
  { bg: "bg-teal-600",    text: "text-teal-400"    },
];

function colorIndex(name: string): number {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(hash) % AVATAR_COLORS.length;
}

export function avatarBgColor(name: string): string {
  return AVATAR_COLORS[colorIndex(name)].bg;
}

export function avatarTextColor(name: string): string {
  return AVATAR_COLORS[colorIndex(name)].text;
}
