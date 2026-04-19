// Build a public profile URL for a given platform + handle.
// Strips leading @, URL-encodes, returns null if no usable handle.
export function buildPlatformUrl(platform: string, handle: string | null | undefined): string | null {
  if (!handle) return null;
  const h = String(handle).trim().replace(/^@+/, "");
  if (!h) return null;
  const enc = encodeURIComponent(h);
  switch (platform) {
    case "youtube":
      // Works for both @handles and channel names
      return `https://www.youtube.com/@${enc}`;
    case "facebook":
      // Numeric page IDs and vanity names both resolve via /<handle>
      return `https://www.facebook.com/${enc}`;
    case "instagram":
      return `https://www.instagram.com/${enc}/`;
    case "tiktok":
      return `https://www.tiktok.com/@${enc}`;
    case "linkedin":
      return `https://www.linkedin.com/in/${enc}`;
    case "x":
      return `https://x.com/${enc}`;
    case "threads":
      return `https://www.threads.net/@${enc}`;
    case "pinterest":
      return `https://www.pinterest.com/${enc}/`;
    case "reddit":
      return `https://www.reddit.com/user/${enc}`;
    case "bluesky":
      return `https://bsky.app/profile/${enc}`;
    default:
      return null;
  }
}
