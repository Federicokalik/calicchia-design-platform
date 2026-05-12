export interface TeamSocial {
  label: string;
  url: string;
}

export interface TeamMember {
  id: number;
  name: string;
  role: string;
  /** 600x600 webp avatar */
  avatar: {
    src: string;
    alt: string;
    width: number;
    height: number;
  };
  socials: TeamSocial[];
}

export const TEAM: TeamMember[] = [
  {
    id: 1,
    name: 'Paolo Campione',
    role: 'Digital Marketing & Comunicazione',
    avatar: {
      src: '/img/team/paolo-campione-3pcomunication.webp',
      alt: 'Paolo Campione — 3PComunication',
      width: 600,
      height: 600,
    },
    socials: [
      { label: 'Sito web', url: 'https://3pcomunication.it/' },
      { label: 'Instagram', url: 'https://www.instagram.com/3pcomunication/' },
      { label: 'Facebook', url: 'https://www.facebook.com/3pcomunication' },
    ],
  },
  {
    id: 2,
    name: 'Davide Massa',
    role: 'Graphic Design & Comunicazione visiva',
    avatar: {
      src: '/img/team/davide-massa-dmgraphic.webp',
      alt: 'Davide Massa — DMgraphic',
      width: 600,
      height: 600,
    },
    socials: [
      { label: 'Sito web', url: 'https://www.dmgraphic.com/' },
      { label: 'Instagram', url: 'https://www.instagram.com/d.mgraphic/' },
      { label: 'Facebook', url: 'https://www.facebook.com/dmgraphicgrafico' },
    ],
  },
];
