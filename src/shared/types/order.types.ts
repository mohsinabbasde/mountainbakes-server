export type OrderStatus = 'pending' | 'preparing' | 'ready' | 'delivered' | 'cancelled';
// 'staff' is production-counter only and takes no money — it is exempt from
// payment and excluded from every revenue total. It is in this union because an
// order can carry it, not because it is offered alongside the others: the branch
// UI and /api/orders/pos both validate against the narrower
// PAYMENT_METHOD_VALUES, which does not include it.
export type PaymentMethod = 'cash' | 'easypaisa' | 'foodpanda' | 'bank_account' | 'staff';

export interface OrderItem {
  productId: string;
  productName: string;
  categoryId: string;
  categoryName: string;
  unitPrice: number;
  qty: number;
  discount: number;
  lineTotal: number;
}

export interface Order {
  id: string;
  orderNumber: string;
  branchId: string;
  branchName: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  items: OrderItem[];
  subtotal: number;
  discountTotal: number;
  deliveryCharges: number;
  taxRate: number;
  taxAmount: number;
  grandTotal: number;
  paymentMethod: PaymentMethod;
  status: OrderStatus;
  receivedCash?: number; // cash tendered by the customer (cash payments only)
  cashReturned?: number; // change given back = receivedCash - grandTotal (cash only)
  notes: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOrderPayload {
  branchId: string;
  customerId: string;
  items: {
    productId: string;
    qty: number;
    discount: number;
  }[];
  paymentMethod: PaymentMethod;
  deliveryCharges: number;
  notes: string;
}

export interface UpdateOrderStatusPayload {
  status: OrderStatus;
}

export interface OrderSummary {
  totalOrders: number;
  totalRevenue: number;
  pendingOrders: number;
  completedOrders: number;
  cancelledOrders: number;
  averageOrderValue: number;
}
