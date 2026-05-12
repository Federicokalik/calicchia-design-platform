import { z } from 'zod';

export const contactSchema = z.object({
  name: z.string().min(2, 'Il nome deve avere almeno 2 caratteri'),
  email: z.string().email('Email non valida'),
  subject: z.string().optional(),
  message: z.string().min(10, 'Il messaggio deve avere almeno 10 caratteri'),
});

export type ContactFormData = z.infer<typeof contactSchema>;

export const projectSchema = z.object({
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, 'Slug deve contenere solo lettere minuscole, numeri e trattini'),
  title: z.string().min(1, 'Titolo richiesto'),
  description: z.string().optional(),
  content: z.string().optional(),
  excerpt: z.string().optional(),
  cover_image: z.string().url().optional().or(z.literal('')),
  gallery: z.array(z.string().url()).optional(),
  technologies: z.array(z.string()).optional(),
  live_url: z.string().url().optional().or(z.literal('')),
  repo_url: z.string().url().optional().or(z.literal('')),
  is_featured: z.boolean().optional(),
  is_published: z.boolean().optional(),
  display_order: z.number().int().optional(),
});

export type ProjectFormData = z.infer<typeof projectSchema>;

export const blogPostSchema = z.object({
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, 'Slug deve contenere solo lettere minuscole, numeri e trattini'),
  title: z.string().min(1, 'Titolo richiesto'),
  content: z.string().min(1, 'Contenuto richiesto'),
  excerpt: z.string().optional(),
  cover_image: z.string().url().optional().or(z.literal('')),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  is_published: z.boolean().optional(),
  allow_comments: z.boolean().optional(),
});

export type BlogPostFormData = z.infer<typeof blogPostSchema>;

export const loginSchema = z.object({
  email: z.string().email('Email non valida'),
  password: z.string().min(6, 'Password deve avere almeno 6 caratteri'),
});

export type LoginFormData = z.infer<typeof loginSchema>;
