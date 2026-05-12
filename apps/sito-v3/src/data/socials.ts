export interface SocialLink {
  label: string;
  url: string;
  /** Phosphor icon class (e.g. "ph ph-instagram-logo") */
  icon: string;
}

export const SOCIALS: SocialLink[] = [
  {
    label: 'Instagram',
    url: 'https://instagram.com/calicchia.design',
    icon: 'ph ph-instagram-logo',
  },
  {
    label: 'LinkedIn',
    url: 'https://linkedin.com/in/federicocalicchia',
    icon: 'ph ph-linkedin-logo',
  },
  {
    label: 'GitHub',
    url: 'https://github.com/Federicokalik/',
    icon: 'ph ph-github-logo',
  },
  {
    label: 'Facebook',
    url: 'https://facebook.com/calicchiadesign',
    icon: 'ph ph-facebook-logo',
  },
  {
    label: 'Telegram',
    url: 'https://t.me/calicchiadesign',
    icon: 'ph ph-telegram-logo',
  },
  {
    label: 'WhatsApp',
    url: 'https://wa.me/393517773467',
    icon: 'ph ph-whatsapp-logo',
  },
];
