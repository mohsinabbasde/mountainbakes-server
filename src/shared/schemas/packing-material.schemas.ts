import { z } from 'zod';

// Packing materials deliberately have NO price and NO costPrice — compare
// CreateProductSchema, which requires both. Adding them here would be the first
// step back toward treating these as saleable products.

export const CreatePackingMaterialSchema = z.object({
  materialCode: z.string().min(2, 'Code is required'),
  materialName: z.string().min(2, 'Packing material name is required'),
  category: z.string().default(''),
  description: z.string().default(''),
});

export const UpdatePackingMaterialSchema = z.object({
  materialCode: z.string().min(2).optional(),
  materialName: z.string().min(2).optional(),
  category: z.string().optional(),
  description: z.string().optional(),
  isActive: z.boolean().optional(),
});

export type CreatePackingMaterialInput = z.infer<typeof CreatePackingMaterialSchema>;
export type UpdatePackingMaterialInput = z.infer<typeof UpdatePackingMaterialSchema>;
