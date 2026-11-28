import { apiClient, delay, USE_MOCK_API, hasValidLiveAuth, canAccessSellerApi, markSellerApiForbidden } from './apiClient.js';
import { db } from '../mock/db.js';
import { orderService } from './order.service.js';

function filterCustomerList(list, params = {}) {
  let result = Array.isArray(list) ? list : [];
  if (params.status && params.status !== 'All') {
    const target = String(params.status).toLowerCase();
    result = result.filter((c) => String(c.status || 'Active').toLowerCase() === target);
  }
  const qRaw = params.search || params.q;
  if (qRaw && String(qRaw).trim()) {
    const q = String(qRaw).trim().toLowerCase();
    result = result.filter(
      (c) =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.company || '').toLowerCase().includes(q) ||
        (c.email || '').toLowerCase().includes(q) ||
        (c.phone || '').toLowerCase().includes(q) ||
        (c.gstin || '').toLowerCase().includes(q) ||
        (c.city || '').toLowerCase().includes(q)
    );
  }
  return result;
}

async function deriveCustomersFromOrders() {
  try {
    const orders = await orderService.getOrders();
    const map = new Map();
    (orders || []).forEach((o, idx) => {
      const b = o.buyer || {};
      const key = b.id || b.email || b.phone || b.company || b.name || `buyer_${idx}`;
      if (!map.has(key)) {
        map.set(key, {
          id: b.id || String(key),
          name: b.name || 'B2B Buyer',
          company: b.company || b.name || 'Enterprise Client',
          email: b.email || '',
          phone: b.phone || '',
          gstin: b.gstin || '',
          city: o.deliveryAddress?.city || b.city || '',
          state: o.deliveryAddress?.state || b.state || '',
          status: 'Active',
          totalOrders: 0,
          totalSpent: 0,
          lastOrderDate: o.createdAt,
        });
      }
      const entry = map.get(key);
      entry.totalOrders += 1;
      entry.totalSpent += Number(o.totalAmount || 0);
      if (o.createdAt && (!entry.lastOrderDate || new Date(o.createdAt) > new Date(entry.lastOrderDate))) {
        entry.lastOrderDate = o.createdAt;
      }
    });
    return Array.from(map.values());
  } catch (_) {
    return [];
  }
}

export const customerService = {
  // GET /api/customers (guarded) or derived from seller orders in live mode
  async getCustomers(params = {}) {
    if (!USE_MOCK_API && hasValidLiveAuth() && canAccessSellerApi('/api/customers')) {
      try {
        const resp = await apiClient.get('/api/customers', { params });
        const raw = resp.data?.data || resp.data?.customers || resp.data;
        const list = Array.isArray(raw) ? raw : Array.isArray(raw?.content) ? raw.content : null;
        if (Array.isArray(list)) {
          const filtered = filterCustomerList(list, params);
          return {
            data: filtered,
            total: resp.data?.total ?? filtered.length,
          };
        }
      } catch (e) {
        if (e?.response?.status === 403) {
          markSellerApiForbidden('/api/customers');
        }
      }
    }

    if (!USE_MOCK_API) {
      const derived = await deriveCustomersFromOrders();
      const filtered = filterCustomerList(derived, params);
      return {
        data: filtered,
        total: filtered.length,
      };
    }

    await delay(150);
    const customers = db.getCustomers ? db.getCustomers(params) : [];
    return {
      data: customers,
      total: customers.length,
    };
  },

  // GET /api/customers/:id
  async getCustomerById(id) {
    if (!USE_MOCK_API && hasValidLiveAuth() && canAccessSellerApi('/api/customers')) {
      try {
        const resp = await apiClient.get(`/api/customers/${id}`);
        const data = resp.data?.data || resp.data?.customer || resp.data;
        if (data && typeof data === 'object') return data;
      } catch (e) {
        if (e?.response?.status === 403) {
          markSellerApiForbidden('/api/customers');
        }
      }
    }

    if (!USE_MOCK_API) {
      const { data } = await this.getCustomers();
      const found = (data || []).find((c) => String(c.id) === String(id));
      if (found) return found;
      throw new Error(`Customer with ID ${id} not found`);
    }

    await delay(100);
    const customer = db.getCustomerById ? db.getCustomerById(id) : null;
    if (!customer) throw new Error(`Customer with ID ${id} not found`);
    return customer;
  },

  // POST /api/customers
  async createCustomer(customerData) {
    if (!USE_MOCK_API && hasValidLiveAuth() && canAccessSellerApi('/api/customers')) {
      try {
        const resp = await apiClient.post('/api/customers', customerData);
        const data = resp.data?.data || resp.data?.customer || resp.data;
        if (data) return data;
      } catch (e) {
        if (e?.response?.status === 403) {
          markSellerApiForbidden('/api/customers');
          throw new Error(
            e?.response?.data?.message || 'Customer directory creation requires admin permissions on the backend.'
          );
        }
        throw new Error(e?.response?.data?.message || e.message || 'Failed to create customer.');
      }
    }

    if (!USE_MOCK_API) {
      throw new Error('Customer directory creation requires backend admin permission (/api/customers is restricted).');
    }

    await delay(250);
    return db.createCustomer ? db.createCustomer(customerData) : { id: `cust_${Date.now()}`, ...customerData };
  },

  // PUT /api/customers/:id
  async updateCustomer(id, updates) {
    if (!USE_MOCK_API && hasValidLiveAuth() && canAccessSellerApi('/api/customers')) {
      try {
        const resp = await apiClient.put(`/api/customers/${id}`, updates);
        const data = resp.data?.data || resp.data?.customer || resp.data;
        if (data) return data;
      } catch (e) {
        if (e?.response?.status === 403) {
          markSellerApiForbidden('/api/customers');
        }
        throw new Error(e?.response?.data?.message || e.message || 'Failed to update customer.');
      }
    }

    if (!USE_MOCK_API) {
      throw new Error('Customer updates require backend admin permission.');
    }

    await delay(200);
    const updated = db.updateCustomer ? db.updateCustomer(id, updates) : null;
    if (!updated) throw new Error(`Customer with ID ${id} not found`);
    return updated;
  },

  // PATCH /api/customers/:id/status
  async updateCustomerStatus(id, status) {
    if (!USE_MOCK_API && hasValidLiveAuth() && canAccessSellerApi('/api/customers')) {
      try {
        const resp = await apiClient.patch(`/api/customers/${id}/status`, { status });
        const data = resp.data?.data || resp.data?.customer || resp.data;
        if (data) return data;
      } catch (e) {
        if (e?.response?.status === 403) {
          markSellerApiForbidden('/api/customers');
        }
        throw new Error(e?.response?.data?.message || e.message || 'Failed to update customer status.');
      }
    }

    if (!USE_MOCK_API) {
      throw new Error('Customer status updates require backend admin permission.');
    }

    await delay(150);
    const updated = db.updateCustomerStatus ? db.updateCustomerStatus(id, status) : null;
    if (!updated) throw new Error(`Customer with ID ${id} not found`);
    return updated;
  },

  // Client-side filtered lookup avoiding broken /api/customers/search (400) and /api/seller/customers (404)
  async searchCustomers(query = '') {
    if (!USE_MOCK_API) {
      const { data } = await this.getCustomers({ search: query });
      return data || [];
    }

    await delay(100);
    return db.searchCustomers ? db.searchCustomers(query) : [];
  },
};
