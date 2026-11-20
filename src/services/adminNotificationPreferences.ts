/** Dashboard inbox preferences; existing history is retained when notifications are disabled. */
export function allowsAdminNotification(preferences: any, kind: string, priority?: unknown) {
  const settings = preferences?.notifications ?? {};
  if (settings.push === false) return false;
  if (kind === 'report' && settings.reports === false) return false;
  if (kind === 'alert' && String(priority ?? '').trim().toLowerCase() === 'critical' && settings.critical === false) return false;
  return true;
}
