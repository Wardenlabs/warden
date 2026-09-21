// Executable scripts stay external; style attributes support the existing motion code.
// Form redirects must permit GitHub and its release CDN for native installer downloads.
export const securityHeaders = {
  'Content-Security-Policy': [
    "default-src 'self'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'",
    "script-src 'self' https://us-assets.i.posthog.com",
    "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
    "font-src 'self'", "media-src 'self'", "worker-src 'self' blob:",
    "connect-src 'self' https://us.i.posthog.com https://us-assets.i.posthog.com",
    "form-action 'self' https://github.com https://release-assets.githubusercontent.com",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};
