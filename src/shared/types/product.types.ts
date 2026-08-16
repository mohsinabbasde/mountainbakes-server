export interface Category {
  id: string;
  name: string;
  slug: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
}

export interface Product {
  id: string;
  name: string;
  categoryId: string;
  categoryName: string;
  sku: string;
  price: number;
  costPrice: number;
  description: string;
  isActive: boolean;
  /**
   * Auto-created to carry a branch Special Order Item (migration 69).
   *
   * Real and active, so stock and production stock work on it normally, but
   * hidden from every catalogue a person picks from — the branch order form,
   * the price list, the POS. `GET /api/products` filters these out unless asked
   * for with `includeSpecial=true`, so most callers never see one.
   */
  isSpecial?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProductPayload {
  name: string;
  categoryId: string;
  sku: string;
  price: number;
  costPrice: number;
  description: string;
}

export interface UpdateProductPayload {
  name?: string;
  categoryId?: string;
  sku?: string;
  price?: number;
  costPrice?: number;
  description?: string;
  isActive?: boolean;
}

export interface CreateCategoryPayload {
  name: string;
  sortOrder?: number;
}
