/* Rotating QR invite. A short-lived cr1. token that rings the host
   like an incoming call when someone scans it. */
export const ROTATE_TOKEN = /^cr1\.[A-Za-z0-9_-]{8,80}$/;
export const ROTATE_MS = 2 * 60 * 1000;
export const ROTATE_REFRESH_MS = 30 * 1000;
