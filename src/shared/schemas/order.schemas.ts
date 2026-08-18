import { z } from 'zod';
import { optionalBusinessDate } from './business-date.schemas';

// Branch-facing payment methods (retail sales). Replaces the legacy cash/card/online set.
export const PAYMENT_METHOD_VALUES = ['cash', 'easypaisa', 'foodpanda', 'bank_account'] as const;

export const OrderItemSchema = z.object({
  productId: z.string().min(1, 'Product is required'),
  qty: z.number().int().positive('Quantity must be at least 1'),
  discount: z.number().min(0, 'Discount cannot be negative').default(0),
});

export const CreateOrderSchema = z.object({
  branchId: z.string().min(1, 'Branch is required'),
  customerId: z.string().min(1, 'Customer is required'),
  items: z.array(OrderItemSchema).min(1, 'At least one item is required'),
  paymentMethod: z.enum(PAYMENT_METHOD_VALUES),
  deliveryCharges: z.number().min(0).default(0),
  notes: z.string().default(''),
  // Sent by the mobile app only; see business-date.schemas.ts.
  businessDate: optionalBusinessDate,
});

// Retail POS sale: free-text customer (no customers-collection lookup), immediate completion.
export const CreatePosSaleSchema = z.object({
  branchId: z.string().min(1, 'Branch is required'),
  customerName: z.string().default(''),
  customerPhone: z.string().default(''),
  items: z.array(OrderItemSchema).min(1, 'At least one item is required'),
  paymentMethod: z.enum(PAYMENT_METHOD_VALUES),
  // Cash tendered by the customer. Only meaningful for cash payments; the server
  // validates it covers the grand total and derives the change to return.
  receivedCash: z.number().min(0).optional(),
  notes: z.string().default(''),
  businessDate: optionalBusinessDate,
});

/**
 * The production counter sells the same way but may also book a sale to 'staff'.
 * Kept as its own list so PAYMENT_METHOD_VALUES stays narrow — that is what makes
 * /api/orders/pos and the branch UI reject 'staff' without any extra check.
 */
export const PRODUCTION_SALE_PAYMENT_METHOD_VALUES = [...PAYMENT_METHOD_VALUES, 'staff'] as const;

/**
 * Production-counter sale. Same shape as the POS sale with two differences:
 *
 * - `branchId` is optional and ignored — these orders have no branch of their own,
 *   so the server pins them to the Production sentinel branch (migration 37). A
 *   client value is never trusted.
 * - `paymentMethod: 'staff'` means no money was taken. Because it is exempt from
 *   payment and excluded from every revenue total, it REQUIRES a comment — that
 *   note is the only record of who took what and why, so an empty one would make
 *   the sale unauditable.
 */
export const CreateProductionSaleSchema = z
  .object({
    branchId: z.string().optional(),
    customerName: z.string().default(''),
    customerPhone: z.string().default(''),
    items: z.array(OrderItemSchema).min(1, 'At least one item is required'),
    paymentMethod: z.enum(PRODUCTION_SALE_PAYMENT_METHOD_VALUES),
    receivedCash: z.number().min(0).optional(),
    notes: z.string().default(''),
  })
  .superRefine((val, ctx) => {
    if (val.paymentMethod === 'staff' && !val.notes.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        // Pathed at `notes` so react-hook-form renders it on the comment field
        // rather than as a form-level error the user has to hunt for.
        path: ['notes'],
        message: 'A comment is required for a staff sale',
      });
    }
  });

export const UpdateOrderStatusSchema = z.object({
  status: z.enum(['pending', 'preparing', 'ready', 'delivered', 'cancelled']),
});

export type CreateOrderInput = z.infer<typeof CreateOrderSchema>;
export type CreatePosSaleInput = z.infer<typeof CreatePosSaleSchema>;
export type CreateProductionSaleInput = z.infer<typeof CreateProductionSaleSchema>;
export type UpdateOrderStatusInput = z.infer<typeof UpdateOrderStatusSchema>;
