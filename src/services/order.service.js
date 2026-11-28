import { db } from '../mock/db.js';
import { apiClient, delay, USE_MOCK_API, canAccessSellerApi, markSellerApiForbidden } from './api.js';
import { isValidTransition } from '../constants/orderStatus.js';

export function mapToBackendStatus(status) {
  if (!status) return 'PLACED';
  const s = String(status).trim().toUpperCase();
  if (s === 'NEW' || s === 'PENDING' || s === 'PLACED') return 'PLACED';
  if (s === 'CONFIRMED') return 'CONFIRMED';
  if (s === 'PROCESSING' || s === 'PACKED' || s === 'PACKED / READY' || s === 'READY FOR DISPATCH' || s === 'READY') {
    return 'PROCESSING';
  }
  if (s === 'DISPATCHED' || s === 'SHIPPED') {
    return 'DISPATCHED';
  }
  if (s === 'IN TRANSIT' || s === 'IN-TRANSIT' || s === 'IN_TRANSIT') {
    return 'IN_TRANSIT';
  }
  if (s === 'DELIVERED' || s === 'COMPLETED' || s === 'POD CONFIRMED') {
    return 'DELIVERED';
  }
  if (s === 'CANCELLED' || s === 'REJECTED') return 'CANCELLED';
  return s;
}

export function normalizeOrderStatus(rawStatus) {
  if (!rawStatus) return 'New';
  const s = String(rawStatus).trim().toUpperCase();
  if (s === 'PLACED' || s === 'NEW') return 'New';
  if (s === 'CONFIRMED') return 'Confirmed';
  if (s === 'PROCESSING') return 'Processing';
  if (s === 'PACKED / READY' || s === 'PACKED' || s === 'READY FOR DISPATCH') return 'Packed / Ready';
  if (s === 'DISPATCHED') return 'Dispatched';
  if (s === 'IN TRANSIT' || s === 'IN-TRANSIT') return 'In Transit';
  if (s === 'DELIVERED') return 'Delivered';
  if (s === 'COMPLETED') return 'Completed';
  if (s === 'CANCELLED') return 'Cancelled';
  return rawStatus.charAt(0).toUpperCase() + rawStatus.slice(1).toLowerCase();
}

export function normalizeOrder(raw) {
  if (!raw) return null;
  const id = raw.id || raw.orderId || raw.order_id;
  const orderNumber = raw.orderNumber || raw.order_number || (id ? `ORD-${id}` : `ORD-${Date.now().toString().slice(-6)}`);
  const createdAt = raw.createdAt || raw.created_at || raw.orderDate || raw.date || new Date().toISOString();

  // Normalize buyer / customer
  const customerName = raw.customerName || raw.customer_name || raw.buyerName || raw.buyer_name || raw.buyer?.name || 'Customer';
  const customerCompany = raw.customerCompany || raw.customer_company || raw.buyerCompany || raw.buyer_company || raw.buyer?.company || customerName;
  const buyer = {
    name: customerName,
    company: customerCompany,
    email: raw.customerEmail || raw.customer_email || raw.buyer?.email || '',
    phone: raw.customerPhone || raw.customer_phone || raw.buyer?.phone || '',
    gstin: raw.buyerGstin || raw.customerGstin || raw.buyer?.gstin || '',
    ...(raw.buyer || {}),
  };

  // Normalize items
  const rawItems = raw.items || raw.orderItems || raw.order_items || [];
  const items = Array.isArray(rawItems)
    ? rawItems.map((item) => ({
        id: item.id || item.productId || item.product_id,
        productId: item.productId || item.product_id || item.id,
        name: item.name || item.productName || item.product_name || item.title || 'Product Item',
        sku: item.sku || 'SKU-GEN',
        quantity: Number(item.quantity ?? item.qty ?? 1),
        unit: item.unit || 'Pieces',
        price: Number(item.price ?? item.unitPrice ?? item.unit_price ?? 0),
        total: Number(item.total ?? item.totalPrice ?? item.total_price ?? ((item.quantity || 1) * (item.price || 0))),
        imageUrl: item.imageUrl || item.image || null,
        sellerId: item.sellerId || item.seller_id || raw.sellerId || raw.seller_id,
      }))
    : [];

  const totalAmount = Number(raw.totalAmount ?? raw.total_amount ?? raw.total ?? raw.grandTotal ?? 0);
  const subtotal = Number(raw.subtotal ?? raw.sub_total ?? totalAmount);
  const gstAmount = Number(raw.gstAmount ?? raw.gst_amount ?? raw.tax ?? 0);
  const rawStatus = raw.orderStatus || raw.order_status || raw.status || 'Pending';
  const orderStatus = normalizeOrderStatus(rawStatus);
  const paymentStatus = raw.paymentStatus || raw.payment_status || (raw.paid ? 'Paid' : 'Pending');

  return {
    ...raw,
    id,
    orderNumber,
    createdAt,
    buyer,
    items,
    totalAmount,
    subtotal,
    gstAmount,
    orderStatus,
    rawOrderStatus: rawStatus,
    backendStatus: rawStatus,
    paymentStatus,
    deliveryAddress: raw.deliveryAddress || raw.delivery_address || raw.shippingAddress || raw.shipping_address || {
      completeAddress: raw.address || 'Delivery Address',
      city: raw.city || 'Site',
      state: raw.state || '',
      pincode: raw.pincode || '',
    },
    paymentMethod: raw.paymentMethod || raw.payment_method || 'Online Payment',
    invoice: raw.invoice || null,
  };
}

export const orderService = {
  /**
   * Phase 6 — Order Fulfilment
   * GET /api/seller/orders or /api/orders (scoped to authenticated seller)
   */
  async getOrders(filters = {}) {
    const currentSeller = db.getSeller();
    const currentAuth = db.getAuth();
    const storedSellerId = typeof localStorage !== 'undefined'
      ? (localStorage.getItem('sellerId') || localStorage.getItem('hinchmart_seller_id') || localStorage.getItem('hinchmart_active_seller_id'))
      : null;
    const rawSellerId = storedSellerId || currentAuth?.user?.sellerId || currentAuth?.user?.id || currentSeller?.sellerId || currentSeller?.id;
    const cleanSellerId = rawSellerId ? String(rawSellerId).replace(/^seller_/, '').trim() : null;

    if (!USE_MOCK_API) {
      const queryParams = { ...filters };
      // Never send sellerId or storeId - backend identifies seller from token
      delete queryParams.sellerId;
      delete queryParams.storeId;
      if (filters.status && filters.status !== 'All') {
        queryParams.status = mapToBackendStatus(filters.status);
      }

      const extractList = (res) => {
        const raw = res?.data?.data || res?.data;
        if (Array.isArray(raw)) return raw;
        if (raw?.content && Array.isArray(raw.content)) return raw.content;
        if (raw?.orders && Array.isArray(raw.orders)) return raw.orders;
        return null;
      };

      // 1. Try dedicated seller endpoint if permitted: GET /api/seller/orders
      if (canAccessSellerApi('/api/seller/orders')) {
        try {
          const response = await apiClient.get('/api/seller/orders', { params: queryParams });
          const list = extractList(response);
          if (Array.isArray(list)) {
            return list.map(normalizeOrder);
          }
        } catch (err1) {
          if (err1?.response?.status === 403) {
            markSellerApiForbidden('/api/seller/orders');
          }
        }
      }

      // 2. Fallback to general order endpoint independently: GET /api/orders
      if (canAccessSellerApi('/api/orders')) {
        try {
          const response = await apiClient.get('/api/orders', { params: queryParams });
          const list = extractList(response);
          if (Array.isArray(list)) {
            return list.map(normalizeOrder);
          }
        } catch (err2) {
          if (err2?.response?.status === 403) {
            markSellerApiForbidden('/api/orders');
          }
        }
      }

      if (!USE_MOCK_API) {
        return [];
      }
    }

    await delay(150);
    let orders = (db.getOrders() || []).map(normalizeOrder);

    // 1. Status Filter
    if (filters.status && filters.status !== 'All') {
      const statusFilter = filters.status.toLowerCase();
      if (statusFilter === 'new' || statusFilter === 'pending') {
        orders = orders.filter((o) => ['new', 'pending'].includes(o.orderStatus.toLowerCase()));
      } else if (statusFilter === 'packed / ready' || statusFilter === 'ready for dispatch' || statusFilter === 'ready') {
        orders = orders.filter((o) => ['ready for dispatch', 'packed / ready', 'packed', 'ready'].includes(o.orderStatus.toLowerCase()));
      } else if (statusFilter === 'delivered' || statusFilter === 'completed') {
        if (statusFilter === 'delivered') {
          orders = orders.filter((o) => ['delivered', 'completed'].includes(o.orderStatus.toLowerCase()));
        } else {
          orders = orders.filter((o) => o.orderStatus.toLowerCase() === 'completed');
        }
      } else {
        orders = orders.filter((o) => o.orderStatus.toLowerCase() === statusFilter);
      }
    }

    // 2. Customer Filter
    if (filters.customer && filters.customer !== 'All') {
      const customerQ = filters.customer.toLowerCase();
      orders = orders.filter((o) =>
        o.buyer?.company?.toLowerCase().includes(customerQ) ||
        o.buyer?.name?.toLowerCase().includes(customerQ)
      );
    }

    // 3. Payment Status Filter
    if (filters.paymentStatus && filters.paymentStatus !== 'All') {
      const payQ = filters.paymentStatus.toLowerCase();
      orders = orders.filter((o) => o.paymentStatus?.toLowerCase().includes(payQ));
    }

    // 4. Delivery Status Filter
    if (filters.deliveryStatus && filters.deliveryStatus !== 'All') {
      const delQ = filters.deliveryStatus.toLowerCase();
      orders = orders.filter((o) => o.orderStatus?.toLowerCase().includes(delQ));
    }

    // 5. Search Query across Order ID, Company, Buyer Name, Product Names, Invoice Number
    if (filters.search && filters.search.trim()) {
      const q = filters.search.trim().toLowerCase();
      orders = orders.filter((o) => {
        const matchNumber = o.orderNumber?.toLowerCase().includes(q);
        const matchCompany = o.buyer?.company?.toLowerCase().includes(q);
        const matchBuyer = o.buyer?.name?.toLowerCase().includes(q);
        const matchInvoice = o.invoice?.invoiceNumber?.toLowerCase().includes(q);
        const matchCity = o.deliveryAddress?.city?.toLowerCase().includes(q);
        const matchSite = o.deliveryAddress?.siteName?.toLowerCase().includes(q);
        const matchItems = (o.items || []).some((item) =>
          item.name?.toLowerCase().includes(q) || item.sku?.toLowerCase().includes(q)
        );

        return matchNumber || matchCompany || matchBuyer || matchInvoice || matchCity || matchSite || matchItems;
      });
    }

    // 6. Value Filter
    if (filters.minValue) {
      orders = orders.filter((o) => o.totalAmount >= Number(filters.minValue));
    }
    if (filters.maxValue) {
      orders = orders.filter((o) => o.totalAmount <= Number(filters.maxValue));
    }

    // 7. Date Range Filter
    if (filters.startDate) {
      orders = orders.filter((o) => new Date(o.createdAt) >= new Date(filters.startDate));
    }
    if (filters.endDate) {
      orders = orders.filter((o) => new Date(o.createdAt) <= new Date(filters.endDate));
    }

    return orders;
  },

  /**
   * Create a new purchase order
   * POST /api/orders
   */
  async createOrder(orderData) {
    if (!USE_MOCK_API) {
      try {
        const response = await apiClient.post('/api/orders', orderData);
        const data = response.data?.data || response.data;
        if (data) {
          db.createOrder(data);
          return data;
        }
      } catch (err) {}
    }
    await delay(200);
    return db.createOrder(orderData);
  },

  /**
   * Fetch single order details by ID or Order Number
   * GET /api/seller/orders/{id} or /api/orders/{id}
   */
  async getOrderById(id) {
    if (!USE_MOCK_API) {
      try {
        const response = await apiClient.get(`/api/seller/orders/${id}`);
        const data = response.data?.data || response.data;
        if (data) return normalizeOrder(data);
      } catch (err1) {
        try {
          const response = await apiClient.get(`/api/orders/${id}`);
          const data = response.data?.data || response.data;
          if (data) return normalizeOrder(data);
        } catch (err2) {}
      }
    }
    await delay(100);
    const order = db.getOrderById(id);
    if (!order) throw new Error(`Order ${id} not found.`);
    return normalizeOrder(order);
  },

  /**
   * Generate / Fetch Statutory Commercial Tax Invoice (Idempotent)
   * GET /api/orders/{id}/invoice
   */
  async generateInvoice(id) {
    if (!USE_MOCK_API && id) {
      try {
        const response = await apiClient.get(`/api/orders/${id}/invoice`);
        const invData = response.data?.data || response.data;
        if (invData && typeof invData === 'object') {
          let order = null;
          try {
            order = await this.getOrderById(id);
          } catch (_) {}
          return {
            order: order ? { ...order, invoice: invData } : { id, invoice: invData },
            invoice: invData,
          };
        }
      } catch (err) {
        if (err?.response?.status && err.response.status !== 404 && err.response.status !== 403) {
          console.warn('GET /api/orders/{id}/invoice notice:', err?.response?.data?.message || err.message);
        }
      }
    }

    await delay(150);
    const result = db.generateOrderInvoice(id);
    if (!result.order) {
      if (!USE_MOCK_API) {
        throw new Error('Tax invoice is generated automatically by backend when order is confirmed.');
      }
      throw new Error('Failed to generate Commercial Tax Invoice.');
    }
    return result;
  },

  /**
   * Update Order Status with transition validation and timeline recording
   * PUT /api/orders/{id}/status or PATCH/PUT /api/seller/orders/{id}/status
   */
  async updateOrderStatus(id, { status, notes, dispatchDetails, podDetails }) {
    const backendStatus = mapToBackendStatus(status);
    if (backendStatus === 'DELIVERED') {
      throw new Error('Access denied: Only administrators can mark an order as DELIVERED.');
    }

    const payload = {
      status: backendStatus,
      notes: notes || `Order status updated to ${backendStatus}`,
      location: dispatchDetails?.location || undefined,
      carrierName: dispatchDetails?.transporter || dispatchDetails?.carrierName || undefined,
      vehicleNumber: dispatchDetails?.vehicleNo || dispatchDetails?.vehicleNumber || undefined,
      driverName: dispatchDetails?.driverName || undefined,
      trackingNumber: dispatchDetails?.lrNumber || dispatchDetails?.trackingNumber || undefined,
      estimatedDelivery: dispatchDetails?.estimatedDelivery || undefined,
      dispatchDetails,
      podDetails,
    };

    if (!USE_MOCK_API) {
      let lastForbiddenErr = null;

      if (canAccessSellerApi('/api/seller/orders')) {
        try {
          const response = await apiClient.patch(`/api/seller/orders/${id}/status`, payload);
          const data = response.data?.data || response.data;
          if (data) {
            try { db.updateOrderStatus(id, status, notes, dispatchDetails, podDetails); } catch (_) {}
            return normalizeOrder(data);
          }
        } catch (err1) {
          if (err1?.response?.status === 403) {
            lastForbiddenErr = err1;
          } else {
            try {
              const response = await apiClient.put(`/api/seller/orders/${id}/status`, payload);
              const data = response.data?.data || response.data;
              if (data) {
                try { db.updateOrderStatus(id, status, notes, dispatchDetails, podDetails); } catch (_) {}
                return normalizeOrder(data);
              }
            } catch (err2) {
              if (err2?.response?.status === 403) {
                lastForbiddenErr = err2;
              }
            }
          }
        }
      }

      // Live Spring endpoint supports PUT /api/orders/{id}/status (PATCH returns 405)
      if (canAccessSellerApi('/api/orders')) {
        try {
          const response = await apiClient.put(`/api/orders/${id}/status`, payload);
          const data = response.data?.data || response.data;
          if (data) {
            try { db.updateOrderStatus(id, status, notes, dispatchDetails, podDetails); } catch (_) {}
            return normalizeOrder(data);
          }
        } catch (err3) {
          if (err3?.response?.status === 403) {
            lastForbiddenErr = err3;
          } else {
            console.warn('Update order status notice:', err3?.response?.data?.message || err3?.message);
          }
        }
      }

      if (lastForbiddenErr) {
        const errMsg =
          lastForbiddenErr.response?.data?.message ||
          'Access denied: You do not have permission to perform this status update.';
        throw new Error(errMsg);
      }
    }
    await delay(250);
    const currentOrder = db.getOrderById(id);
    if (!currentOrder) {
      throw new Error(`Order ${id} not found.`);
    }

    // Transition validation
    if (!isValidTransition(currentOrder.orderStatus, status)) {
      console.warn(`Direct status jump from ${currentOrder.orderStatus} to ${status}`);
    }

    return db.updateOrderStatus(id, status, notes, dispatchDetails, podDetails);
  },

  /**
   * Get all commercial invoices for the dedicated Invoices module
   * GET /api/invoices
   */
  async getInvoices() {
    if (!USE_MOCK_API) {
      try {
        const response = await apiClient.get('/api/invoices');
        const raw = response.data?.data ?? response.data;
        const list = Array.isArray(raw)
          ? raw
          : Array.isArray(raw?.content)
          ? raw.content
          : Array.isArray(raw?.invoices)
          ? raw.invoices
          : null;
        if (Array.isArray(list) && list.length > 0) {
          return list;
        }
      } catch (err) {
        console.warn('GET /api/invoices notice:', err?.response?.data?.message || err.message);
      }

      const orders = await this.getOrders();
      return (orders || [])
        .filter((o) => o && o.invoice && o.invoice.invoiceNumber)
        .map((o) => ({
          ...o.invoice,
          orderId: o.id,
          orderNumber: o.orderNumber,
          buyer: o.buyer,
          deliveryAddress: o.deliveryAddress,
          items: o.items,
          paymentStatus: o.paymentStatus,
          orderStatus: o.orderStatus,
          createdAt: o.createdAt,
        }));
    }

    await delay(150);
    const orders = db.getOrders();
    const invoices = orders
      .filter((o) => o.invoice && o.invoice.invoiceNumber)
      .map((o) => ({
        ...o.invoice,
        orderId: o.id,
        orderNumber: o.orderNumber,
        buyer: o.buyer,
        deliveryAddress: o.deliveryAddress,
        items: o.items,
        paymentStatus: o.paymentStatus,
        orderStatus: o.orderStatus,
        createdAt: o.createdAt,
      }));

    return invoices;
  },
};
