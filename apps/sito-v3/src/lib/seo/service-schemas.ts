export interface ServiceOfferCatalogDeliverable {
  title: string;
  format: string;
  timeline: string;
}

export function serviceOfferCatalogSchema(
  deliverables: readonly ServiceOfferCatalogDeliverable[]
) {
  return {
    '@context': 'https://schema.org',
    '@type': 'OfferCatalog',
    itemListElement: deliverables.map((deliverable, i) => ({
      '@type': 'Offer',
      position: i + 1,
      itemOffered: {
        '@type': 'Service',
        name: deliverable.title,
        description: `${deliverable.format} - ${deliverable.timeline}`,
      },
    })),
  };
}
