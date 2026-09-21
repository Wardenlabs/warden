// Public site identity. Keep canonical URLs independent from preview hosts.
export const origin = 'https://warden-theta.vercel.app';
export const repository = 'https://github.com/Wardenlabs/warden';
export const pages = [
  {
    file: 'index.html', path: '/',
    title: 'Warden',
    socialTitle: 'Warden — Your AI. Your rules.',
    description: 'Control what connected AI tools can share. Write rules, review decisions and check requests locally with Warden. Free and open source.',
    image: 'warden-home-v3.png',
    imageAlt: 'Warden shield. Your AI. Your rules. Black and white typography.',
  },
  {
    file: 'how-it-works.html', path: '/how-it-works',
    title: 'How Warden works | Write, review and activate AI rules',
    socialTitle: 'Warden — You set the rule.',
    description: 'Follow a rule from draft to activation. See how Warden blocks a connected request, records the decision and holds requests at a usage limit.',
    image: 'warden-guide-v3.png',
    imageAlt: 'Warden. You set the rule. Describe, review, activate, with the official shield.',
  },
  {
    file: 'docs.html', path: '/docs',
    title: 'Warden documentation | Connections, privacy and deployment',
    socialTitle: 'Warden — Connections, privacy and deployment',
    description: 'Connect AI tools to Warden, choose local request models and understand what leaves your device. Setup, security boundaries and source documentation.',
    image: 'warden-home-v3.png', imageAlt: 'Warden shield. Your AI. Your rules. Black and white typography.',
  },
];
